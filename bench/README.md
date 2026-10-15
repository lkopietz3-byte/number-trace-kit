# bench: reproducible accuracy checks

Everything behind the numbers in the package README's "Accuracy on real output" section. It is a development folder: it is not in the npm package (`files` in `package.json` lists only `dist`, the README and the changelog).

```sh
npm run bench                      # builds, then prints every table below; works offline on the committed data
npm run bench:fetch                # shows what the raw downloads are and what they cost (nothing is fetched)
npm run bench:fetch -- --yes       # downloads and verifies them into bench/.cache (about 41 MB; git-ignored)
npm run bench -- --only holdout    # one section: labeled, field, financebench, holdout
npm run bench -- --verbose         # also lists every item the kit got wrong
npm run crosscheck                 # ICU and Python decimal cross-checks (see ../scripts)
```

What it prints, for each section and setting: honest items the kit flags (false fail), unsupported items it flags (catch), unsupported items it lets through as `clean` (false pass) and the ones it sends to a person (`unknown`), each as `k/n` with a 95% Wilson interval. A section that cannot run says `NOT_RUN` and why. Offline, the question answering and summary parts of RAGTruth run from committed excerpts; data-to-text and FinanceBench need the download.

| Section | Data | Where from | Needs the download |
| --- | --- | --- | --- |
| 1. Labeled benchmark | 203 items (103 honest, 100 with one planted or annotator-labeled error) | TAT-QA, FinQA, RAGTruth | no |
| 2. RAGTruth field corpus | 289 real model answers with annotator labels | RAGTruth test split | for data-to-text (105 answers) |
| 3. FinanceBench | 1,601 human-labeled model answers over 10-K pages | FinanceBench | yes, all of it |
| 4. Fresh holdout | 150 labeled RAGTruth train-split answers, the kit and four plain checkers | RAGTruth train split | for data-to-text (50 answers) |

Read `METHOD.md` before quoting a number: it says how each label was made, which labels were made after the kit's verdicts were seen, and what each data set cannot show. `SOURCES.json` and `NOTICE.md` hold licenses. `data/FROZEN-holdout.sha256` pins the holdout labels and the code that made them.

Layout: `run.mjs` (the runner), `fetch.mjs` (the verified download), `lib/` (readers, label rules, scorers, baselines), `build/` (scripts that rebuild or check the committed data from a raw download, for example `node bench/build/derive.mjs --raw <dir> --check`), `data/` (committed data), `SOURCES.json`, `NOTICE.md`, `METHOD.md`.

The test `test/field-regression.test.ts` runs the committed RAGTruth excerpts under `npm test` and fails when a number is newly flagged, newly unknown, or newly passes.
