# Credits / 素材与数据来源

## 地图数据 Map data

- **OpenStreetMap** — © OpenStreetMap contributors, available under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
  Used for the inner ring road (内环路 A线 / B线) geometry, ramps, lane counts,
  bridge/viaduct layers, surface streets, buildings, water, parks, railways and
  landmark positions. Processed data lives in `public/data/` (a derived database
  under the ODbL).
- **Elevation** — [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen / Tilezen terrarium tiles, derived from SRTM, GMTED and other public
  sources). Used only for the distant hills (白云山、越秀山).

## 纹理 Textures (CC0)

| File | Asset | Author | Source | License |
| --- | --- | --- | --- | --- |
| `public/assets/textures/asphalt_*.jpg` | Asphalt 02 | Rob Tuytel | https://polyhaven.com/a/asphalt_02 | CC0 |
| `public/assets/textures/concrete_*.jpg` | Brushed Concrete | Dario Barresi, Dimitrios Savva | https://polyhaven.com/a/brushed_concrete | CC0 |
| `public/assets/textures/pavement_*.jpg` | Concrete Floor 02 | Rob Tuytel | https://polyhaven.com/a/concrete_floor_02 | CC0 |

## 程序化生成 Procedural content

Vehicles (no brand logos), building facades, road signs (after GB 5768.2-2022),
landmarks, licence plates (粤A), bougainvillea planters, the sky and all audio
are generated at runtime by the game code (GPL-3.0).

## 参考 References

- 维基百科「内环路 (广州)」与百度百科「内环路」：A线逆时针、B线顺时针，全长 26.7 km，
  限速 60 km/h（弯道及出入口 30–40 km/h），出口编号 A1–A19 / B1–B19 等。
- GB 5768.2-2022《道路交通标志和标线 第2部分：道路交通标志》：城市快速路指路标志为绿底白字。
