//! Offline reverse geocoding: nearest city (15k+ people) to a GPS point.
//! Data: GeoNames (CC BY 4.0), embedded as gzip TSV and indexed on first use.

use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

static DATA: &[u8] = include_bytes!("../data/cities.tsv.gz");

pub struct City {
    pub name: String,
    pub cc: String,
    pub lat: f64,
    pub lon: f64,
    pub pop: u32,
}

struct Index {
    cities: Vec<City>,
    countries: HashMap<String, String>,
    grid: HashMap<(i32, i32), Vec<u32>>,
}

fn index() -> &'static Index {
    static IDX: OnceLock<Index> = OnceLock::new();
    IDX.get_or_init(|| {
        let mut text = String::new();
        let _ = GzDecoder::new(DATA).read_to_string(&mut text);
        let mut idx = Index { cities: Vec::with_capacity(35_000), countries: HashMap::new(), grid: HashMap::new() };
        for line in text.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() == 3 && f[0] == "C" {
                idx.countries.insert(f[1].to_string(), f[2].to_string());
            } else if f.len() == 5 {
                let (Ok(lat), Ok(lon)) = (f[2].parse::<f64>(), f[3].parse::<f64>()) else { continue };
                let i = idx.cities.len() as u32;
                idx.grid.entry(cell(lat, lon)).or_default().push(i);
                idx.cities.push(City { name: f[0].to_string(), cc: f[1].to_string(), lat, lon, pop: f[4].parse().unwrap_or(0) });
            }
        }
        idx
    })
}

fn cell(lat: f64, lon: f64) -> (i32, i32) {
    (lat.floor() as i32, lon.floor() as i32)
}

pub fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().asin()
}

/// Nearest city within ~150 km, preferring a bigger city when two are similarly close.
pub fn nearest(lat: f64, lon: f64) -> Option<u32> {
    let idx = index();
    let (cy, cx) = cell(lat, lon);
    let mut best: Option<(u32, f64)> = None;
    for dy in -1..=1 {
        for dx in -1..=1 {
            let Some(list) = idx.grid.get(&(cy + dy, cx + dx)) else { continue };
            for &i in list {
                let c = &idx.cities[i as usize];
                let d = km((lat, lon), (c.lat, c.lon));
                // a metropolis 12 km away beats a suburb 8 km away
                let score = d - (c.pop as f64).log10() * 2.0;
                if d < 150.0 && best.is_none_or(|(_, s)| score < s) {
                    best = Some((i, score));
                }
            }
        }
    }
    best.map(|b| b.0)
}

pub fn city(i: u32) -> &'static City {
    &index().cities[i as usize]
}

pub fn country(cc: &str) -> &'static str {
    index().countries.get(cc).map(|s| s.as_str()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_cities() {
        let kyoto = nearest(35.0116, 135.7681).map(city).unwrap();
        assert_eq!(kyoto.name, "Kyoto");
        assert_eq!(country(&kyoto.cc), "Japan");
        assert_eq!(nearest(38.7223, -9.1393).map(|i| city(i).name.as_str()), Some("Lisbon"));
        assert!(nearest(0.0, -140.0).is_none(), "middle of the Pacific");
    }
}
