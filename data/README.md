# Local source data

Switchback’s Tier 1 build is offline and reproducible from explicit local
inputs. Raw downloads are deliberately ignored by Git: their licence terms and
source metadata still travel with every generated TrailPack manifest.

## Tarragona demo inputs

| File | Purpose | Authority and licence | Retrieval URL | SHA-256 |
| --- | --- | --- | --- | --- |
| `raw/gr-65-5-e03.kml` | Official waymarked spine candidate | CNIG / FEDME, CC-BY 4.0 | `https://centrodedescargas.cnig.es/CentroDescargasRWS/rest/descargarArchivo/usuarioMovil/11020025` | `033162c8955f69e373e9d4baa5b30e9281978b8bb984fe3c03e495beab850b52` |
| `raw/tarragona-latest.osm.pbf` | Walkable connector candidates and terrain tags | OpenStreetMap contributors, ODbL 1.0 | `https://download.openstreetmap.fr/extracts/europe/spain/catalunya/tarragona-latest.osm.pbf` | `4d000336e8600065a33d4792206d5ca62741ea1c49df06ae01e8f24014450c07` |

## Q7 official-start evidence

These are distinct CNIG/FEDME catalog records. Each has at least five
kilometres of *its own* official trace within a five-kilometre geodesic radius
of the stated start; they are not added together, because records may overlap.
The figures establish historical dataset coverage, not present-day access or
route safety.

| Start | CNIG record | Local name | Catalog length | Trace inside 5 km | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| Ulldemolins (`0.880804, 41.320818`) | `11020025` | `raw/gr-65-5-e03.kml` | 24.26 km | 5.40 km | `033162c8955f69e373e9d4baa5b30e9281978b8bb984fe3c03e495beab850b52` |
| Prades (`0.987898, 41.309478`) | `11020491` | `raw/cnig/GRXX0171-00E007-0-gr-171-etapa-07-montblanc-prades.kml` | 24.51 km | 7.36 km | `ee4842eef8d443f571b576a2422c1e3c0d0b984bd0053bd51e89f56121bdeb2d` |
| Albarca (`0.912478, 41.300651`) | `11020492` | `raw/cnig/GRXX0171-00E008-0-gr-171-etapa-08-prades-albarca.kml` | 8.60 km | 6.88 km | `076c7d3635e33b18920d47bac38249a8eaa87dabdfd233af31c0f397fd277c66` |

The CNIG [KML catalog](https://centrodedescargas.cnig.es/CentroDescargas/senderos-fedme-kml.do)
is the canonical record index. Store later downloads as
`data/raw/cnig/<catalog-file-name>` together with their catalog ID, URL,
retrieval date, and SHA-256 in the generated manifest.

Verify a downloaded file before ingesting it:

```sh
shasum -a 256 data/raw/gr-65-5-e03.kml
shasum -a 256 data/raw/tarragona-latest.osm.pbf
```

CNIG/FEDME geometry is official source evidence, not a guarantee that a route
is currently open or safe. OSM tags are community-supplied and are treated as
untrusted text; the pipeline keeps only a small allowlist of routing-relevant
tag values.
