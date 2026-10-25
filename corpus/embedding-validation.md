# Embedding validation

Xenova/bge-base-en-v1.5, 11,784 corpus articles with abstracts. Built 2026-10-25 by `npm run validate-embeddings`. No model judgement is involved.

## 1. Do articles sit close to the articles they cite?
516 sampled articles (2019 on) cite at least one earlier corpus article; 3573 citing-cited pairs in all, from OpenAlex reference lists. Each article's title and abstract (boilerplate removed) is the query for every method; candidates are all earlier corpus articles (about 8,059 each). Recall@k is the share of an article's cited corpus articles that rank in the top k.

| Method | Recall@10 | Recall@50 | MRR | Median rank of a cited article (percentile, 0 = top) |
|---|---|---|---|---|
| Embeddings (bge-base-en-v1.5) | 27.0% | 46.2% | 0.485 | 1.18 |
| BM25 (keywords) | 21.1% | 37.0% | 0.417 | 2.66 |
| Hybrid (both, rank-fused) | 26.3% | 49.3% | 0.479 | 1.00 |
| Chance | 0.1% | 0.7% | – | 50 |

## 2. Do nearest neighbours share an article's journal, field and topic?
For 2,000 sampled articles, the share of its 10 nearest articles (whole corpus) with the same label. Fields are this project's assignment (whole journals, or OpenAlex topics for the 4 split journals); subfields are OpenAlex's.

| Method | Same journal | Same field | Same OpenAlex subfield |
|---|---|---|---|
| Embeddings (bge-base-en-v1.5) | 31.4% | 61.2% | 50.5% |
| BM25 (keywords) | 31.7% | 58.6% | 42.1% |
| Chance | 8.4% | 21.1% | 8.6% |
