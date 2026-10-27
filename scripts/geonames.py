"""Build src-tauri/data/cities.tsv.gz from GeoNames dumps (CC BY 4.0, https://www.geonames.org).

Usage:
  curl -LO https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
  curl -LO https://download.geonames.org/export/dump/countryInfo.txt
  python scripts/geonames.py cities15000.txt countryInfo.txt src-tauri/data/cities.tsv.gz

Output lines: "C<TAB>code<TAB>country name" for countries, then
"name<TAB>country code<TAB>lat<TAB>lon<TAB>population" for every city with 15k+ people.
"""
import gzip
import sys


def main(cities_path: str, countries_path: str, out_path: str) -> None:
    rows = []
    with open(countries_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            c = line.rstrip("\n").split("\t")
            rows.append(f"C\t{c[0]}\t{c[4]}")
    n = 0
    with open(cities_path, encoding="utf-8") as f:
        for line in f:
            c = line.rstrip("\n").split("\t")
            if len(c) < 15:
                continue
            name, lat, lon, cc, pop = c[1], float(c[4]), float(c[5]), c[8], int(c[14] or 0)
            if not name or "\t" in name:
                continue
            rows.append(f"{name}\t{cc}\t{lat:.4f}\t{lon:.4f}\t{pop}")
            n += 1
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=9) as f:
        f.write("\n".join(rows) + "\n")
    print(f"{n} cities -> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
