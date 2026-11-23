[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Tianchen0012/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Tianchen0012/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed — a faster makefun-site

A make.fun bounty entry for **site-generator-speed-01-run-20261122**: a
faster drop-in for make.fun's own `makefun-site` 1.0.0 static site generator.

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
the answer `makefun-site` 1.0.0 returns for a case's input — the output tree
of the site build, byte for byte: every page's `index.html`, the index and
tag pages, `build-report.txt`, and each static file. `main.ts` is the program
the harness runs: it reads every case from `/input/cases.json`, answers each
with `run`, and writes `/output/answers.json`.

## Practice results

- Practice set: **3/3 cases byte-identical** to the reference answers.
- Speed on this machine (same practice set, end-to-end): ~0.61–0.75 s vs the
  house baseline's ~0.95–0.99 s — about **1.4× faster**.

## Run it

Node 22 and its standard library alone; there is nothing to install:

    mkdir -p out && MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=out node main.ts

## License

MIT — see [LICENSE](LICENSE).
