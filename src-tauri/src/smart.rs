//! Smart albums, computed on demand from the library: trips, places and rule-based collections.

use crate::{db, geo};
use chrono::{DateTime, Datelike, Local, Timelike};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlbum {
    pub key: String,
    pub kind: &'static str, // "trip" | "place" | "smart"
    pub title: String,
    pub sub: String,
    pub ids: Vec<i64>,
    pub covers: Vec<i64>,
}

struct It {
    id: i64,
    taken: i64,
    kind: i64,
    fav: bool,
    w: i64,
    h: i64,
    name: String,
    dir: String,
    lens: String,
    luma: Option<f64>,
    city: Option<u32>,
}

fn wall(t: i64) -> DateTime<chrono::Utc> {
    DateTime::from_timestamp(t, 0).unwrap_or_default()
}

/// "Oct 3–9, 2026", "Sep 28 – Oct 4, 2026", "Dec 28, 2025 – Jan 3, 2026"
pub fn span(a: i64, b: i64) -> String {
    let (x, y) = (wall(a), wall(b));
    if x.date_naive() == y.date_naive() {
        x.format("%b %-d, %Y").to_string()
    } else if x.year() != y.year() {
        format!("{} – {}", x.format("%b %-d, %Y"), y.format("%b %-d, %Y"))
    } else if x.month() != y.month() {
        format!("{} – {}", x.format("%b %-d"), y.format("%b %-d, %Y"))
    } else {
        format!("{}–{}", x.format("%b %-d"), y.format("%-d, %Y"))
    }
}

fn album(key: String, kind: &'static str, title: String, sub: String, mut items: Vec<&It>) -> SmartAlbum {
    items.sort_by(|a, b| b.taken.cmp(&a.taken).then(b.id.cmp(&a.id)));
    let mut covers: Vec<i64> = items.iter().filter(|i| i.kind == 0).take(3).map(|i| i.id).collect();
    if covers.is_empty() {
        covers = items.iter().take(3).map(|i| i.id).collect();
    }
    SmartAlbum { key, kind, title, sub, ids: items.iter().map(|i| i.id).collect(), covers }
}

fn mode<T: std::hash::Hash + Eq + Copy>(xs: impl Iterator<Item = T>) -> Option<(T, usize)> {
    let mut m: HashMap<T, usize> = HashMap::new();
    for x in xs {
        *m.entry(x).or_default() += 1;
    }
    m.into_iter().max_by_key(|(_, n)| *n)
}

pub fn compute(conn: &Connection) -> rusqlite::Result<Vec<SmartAlbum>> {
    let mut st = conn.prepare(
        "SELECT m.id, m.taken, m.kind, m.favorite, m.width, m.height, m.lat, m.lon, m.name, m.dir, m.lens, a.luma
         FROM media m LEFT JOIN analysis a ON a.media_id = m.id AND a.sharp >= 0
         WHERE m.trashed = 0 ORDER BY m.taken ASC, m.id ASC",
    )?;
    let items: Vec<It> = st
        .query_map([], |r| {
            let (lat, lon): (Option<f64>, Option<f64>) = (r.get(6)?, r.get(7)?);
            let gps = lat.zip(lon);
            Ok(It {
                id: r.get(0)?,
                taken: r.get(1)?,
                kind: r.get(2)?,
                fav: r.get::<_, i64>(3)? != 0,
                w: r.get(4)?,
                h: r.get(5)?,
                name: r.get::<_, String>(8)?.to_lowercase(),
                dir: r.get::<_, String>(9)?.to_lowercase(),
                lens: r.get::<_, Option<String>>(10)?.unwrap_or_default().to_lowercase(),
                luma: r.get(11)?,
                city: gps.and_then(|(la, lo)| geo::nearest(la, lo)),
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut out: Vec<SmartAlbum> = vec![];

    // ---------- trips: time segments whose photos cluster far from home ----------
    let home = mode(items.iter().filter_map(|i| i.city)).map(|(c, _)| c);
    let home_pos = home.map(|c| (geo::city(c).lat, geo::city(c).lon));
    let mut segments: Vec<Vec<&It>> = vec![];
    for it in &items {
        match segments.last_mut() {
            Some(seg) if it.taken - seg.last().unwrap().taken <= 30 * 3600 => seg.push(it),
            _ => segments.push(vec![it]),
        }
    }
    let mut trips: Vec<(u32, Vec<&It>)> = vec![];
    for seg in segments {
        let Some((c, n)) = mode(seg.iter().filter_map(|i| i.city)) else { continue };
        let far = match home_pos {
            Some(h) if Some(c) != home => geo::km(h, (geo::city(c).lat, geo::city(c).lon)) > 60.0,
            _ => false,
        };
        if !far || n < 3 || seg.len() < 6 {
            continue;
        }
        match trips.last_mut() {
            // two days in Kyoto with a quiet day between them are one trip
            Some((pc, prev)) if *pc == c && seg[0].taken - prev.last().unwrap().taken < 4 * 86400 => prev.extend(seg),
            _ => trips.push((c, seg)),
        }
    }
    for (c, seg) in trips.into_iter().rev() {
        let city = geo::city(c);
        let (a, b) = (seg[0].taken, seg.last().unwrap().taken);
        let sub = format!("{} · {}", span(a, b), geo::country(&city.cc));
        out.push(album(format!("trip:{a}:{c}"), "trip", city.name.clone(), sub, seg));
    }

    // ---------- smart collections ----------
    let now = Local::now();
    let rules: [(&str, &str, &str, Box<dyn Fn(&It) -> bool>); 7] = [
        ("favorites", "Favorites", "Everything you've hearted", Box::new(|i: &It| i.fav)),
        ("videos", "Videos", "Every clip, newest first", Box::new(|i: &It| i.kind == db::VIDEO)),
        (
            "screenshots",
            "Screenshots",
            "Found by name and folder",
            Box::new(|i: &It| {
                i.kind == db::PHOTO
                    && ["screenshot", "screen shot", "screen_shot", "scrnshot", "screencap"].iter().any(|k| i.name.contains(k) || i.dir.contains(k))
            }),
        ),
        ("panoramas", "Panoramas", "Extra-wide shots", Box::new(|i: &It| i.kind == db::PHOTO && i.h > 0 && i.w as f64 / i.h as f64 >= 2.3)),
        ("selfies", "Selfies", "Taken with a front camera", Box::new(|i: &It| i.lens.contains("front") || i.name.contains("selfie"))),
        (
            "night",
            "Night",
            "After dark, low light",
            Box::new(|i: &It| {
                let h = wall(i.taken).hour();
                i.kind == db::PHOTO && (h >= 20 || h < 5) && i.luma.is_none_or(|l| l < 80.0)
            }),
        ),
        (
            "onthisday",
            "On this day",
            "",
            Box::new(move |i: &It| {
                let d = wall(i.taken);
                d.month() == now.month() && d.day() == now.day() && d.year() < now.year()
            }),
        ),
    ];
    for (key, title, sub, rule) in rules.iter() {
        let hits: Vec<&It> = items.iter().filter(|i| rule(i)).collect();
        if hits.is_empty() {
            continue;
        }
        let sub = if *key == "onthisday" {
            let years = hits.iter().map(|i| wall(i.taken).year()).collect::<std::collections::BTreeSet<_>>().len();
            format!("{} across {years} year{}", now.format("%B %-d"), if years == 1 { "" } else { "s" })
        } else {
            sub.to_string()
        };
        out.push(album(format!("smart:{key}"), "smart", title.to_string(), sub, hits));
    }
    // insertion order = media id order
    let mut recent: Vec<&It> = items.iter().collect();
    recent.sort_by(|a, b| b.id.cmp(&a.id));
    recent.truncate(200);
    if !recent.is_empty() {
        out.push(album("smart:recent".into(), "smart", "Recently added".into(), "The last 200 files Sitara found".into(), recent));
    }

    // ---------- places ----------
    let mut by_city: HashMap<u32, Vec<&It>> = HashMap::new();
    for it in items.iter().filter(|i| i.city.is_some()) {
        by_city.entry(it.city.unwrap()).or_default().push(it);
    }
    let mut places: Vec<(u32, Vec<&It>)> = by_city.into_iter().filter(|(_, v)| v.len() >= 5).collect();
    places.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    for (c, v) in places.into_iter().take(60) {
        let city = geo::city(c);
        let sub = format!("{}{}", geo::country(&city.cc), if Some(c) == home { " · home" } else { "" });
        out.push(album(format!("place:{c}"), "place", city.name.clone(), sub, v));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{compute, span};
    use rusqlite::{params, Connection};

    #[test]
    fn finds_a_trip_away_from_home_and_places() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c.execute("INSERT INTO folders(path, added_at) VALUES('/p', 0)", []).unwrap();
        let mut n = 0;
        let mut add = |t: i64, lat: f64, lon: f64, name: &str| {
            n += 1;
            c.execute(
                "INSERT INTO media(folder_id,path,dir,name,ext,kind,size,mtime,width,height,taken,lat,lon)
                 VALUES(1,?1,'/p',?2,'jpg',0,1,0,4000,3000,?3,?4,?5)",
                params![format!("/p/{n}.jpg"), name, t, lat, lon],
            )
            .unwrap();
        };
        let day = 86_400;
        let t0 = 1_780_000_000; // 2026
        for d in 0..30 {
            add(t0 + d * 2 * day, 12.97, 77.59, "home.jpg"); // Bengaluru, every other day
        }
        for k in 0..9 {
            add(t0 + 70 * day + k * 8 * 3600, 35.01, 135.77, "trip.jpg"); // Kyoto, 3 days
        }
        add(t0 + 80 * day, 12.97, 77.59, "Screenshot_2026.png");
        let albums = compute(&c).unwrap();
        let trip = albums.iter().find(|a| a.kind == "trip").expect("trip found");
        assert_eq!(trip.title, "Kyoto");
        assert!(trip.sub.ends_with("· Japan"), "{}", trip.sub);
        assert_eq!(trip.ids.len(), 9);
        assert!(albums.iter().any(|a| a.kind == "place" && a.title == "Bengaluru" && a.sub.contains("home")));
        assert!(albums.iter().any(|a| a.key == "smart:screenshots" && a.ids.len() == 1));
        assert_eq!(albums.iter().filter(|a| a.kind == "trip").count(), 1, "home days are not trips");
    }

    #[test]
    fn spans_read_naturally() {
        let d = |y: i32, m: u32, dd: u32| chrono::NaiveDate::from_ymd_opt(y, m, dd).unwrap().and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp();
        assert_eq!(span(d(2026, 10, 3), d(2026, 10, 9)), "Oct 3–9, 2026");
        assert_eq!(span(d(2026, 9, 28), d(2026, 10, 4)), "Sep 28 – Oct 4, 2026");
        assert_eq!(span(d(2025, 12, 28), d(2026, 1, 3)), "Dec 28, 2025 – Jan 3, 2026");
        assert_eq!(span(d(2026, 5, 1), d(2026, 5, 1)), "May 1, 2026");
    }
}
