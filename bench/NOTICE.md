# Third-party data and notices

The files in `bench/data/` contain or derive from the following third-party works. See `SOURCES.json` for URLs, pinned commits, hashes and what is committed.

**TAT-QA** (Zhu et al., ACL 2021), https://github.com/NExTplusplus/TAT-QA. The dataset is licensed under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/). `data/numbers-203.jsonl` holds 147 items built from its financial report tables and paragraphs. Changes made: table rows were rewritten as evidence chunks, answers were composed from the gold derivations, and errors were planted by programmatic edits.

**FinQA** (Chen et al., EMNLP 2021), https://github.com/czyssrs/FinQA. MIT License, Copyright (c) 2021 Zhiyu Chen. `data/numbers-203.jsonl` holds 18 items built from its table rows and gold derivations. The table text comes from public company earnings reports.

**RAGTruth** (Niu et al., ACL 2024), https://github.com/ParticleMedia/RAGTruth. MIT License, Copyright (c) 2023 Particle Media. `data/ragtruth-field.jsonl`, `data/ragtruth-holdout.jsonl` and 38 items of `data/numbers-203.jsonl` hold model answers, annotator span offsets, facts derived from the source, and, for question answering and summaries, number-centered excerpts of the source text (48 characters around each digit). The source texts come from MS MARCO, CNN and Daily Mail, and Yelp; their own terms were not reviewed, which is why only short excerpts of the first two are committed and none of the third.

**FinanceBench** (Islam et al., 2023), https://github.com/patronus-ai/financebench. Reported as CC BY-NC 4.0, a non-commercial license. Nothing from it is committed. `npm run bench:fetch` downloads it into a git-ignored cache for local evaluation.

The labels in `data/holdout-labels.jsonl` and `data/adjudication-manual.json` are this project's own work, made from the annotators' spans and the source texts.
