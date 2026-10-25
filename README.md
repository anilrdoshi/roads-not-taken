# Roads Not Taken

Every empirical paper is one realization of many papers its evidence could have supported. This tool takes a completed paper, the **focal paper**, holds its evidence fixed (setting, data, measures, design and reported results), and asks Claude to write **AI alternatives** built on the same evidence: freely, under a different theory (fine perturbation) or for a different field (coarse perturbation). It then checks each AI alternative against the evidence, compares it with the focal paper, and scores the focal paper and every AI alternative for Fit to five business-school fields and for Novelty within the best-fit field, against the **published corpus** of journal papers. Separately, it measures Distance from text embeddings: how far each AI alternative's text is from the focal paper's, and how far the focal paper and each AI alternative are from the published papers in the corpus.

The tool works on one focal paper at a time. You bring the focal paper (a PDF) and an Anthropic API key; the tool builds the published corpus, runs the test and shows the results in an explorer on your machine.

## Quick start

| To | Do this | You need |
|---|---|---|
| Run the tool without installing anything | [Open it in GitHub Codespaces](https://codespaces.new/anilrdoshi/roads-not-taken). Dependencies install and the explorer opens on port 4373. | A GitHub account |
| Run it on your machine | `npm ci`, then `npm run app` and open http://127.0.0.1:4373/ | Node.js 20.12 or later |
| Check that it works | `npm run check` (offline tests with a mock model) | Nothing more |
| Run it on your own focal paper | Follow [Step by step](#step-by-step-your-own-focal-paper). Extraction costs about $2, a pilot about $5 and the full test about $30–35. | An Anthropic API key with access to Claude Opus 5.5 |

## What it measures

- **Convergence.** Open runs get only the evidence and are asked for an AI alternative in any field, with any theory. The request and the format of the evidence vary from run to run, so agreement among them is not an artifact of one wording. How often do they come back to the focal paper (same paper, close variant, or different paper)?
- **Field reach.** For each of five fields (strategy and organization theory, organizational behavior, information systems, marketing, operations), how well does the focal paper fit, and how well does the highest-fit AI alternative aimed at that field fit? How many parts of the focal paper did it replace, and does it need new data?
- **Theory reach.** For each of 27 theories, can the evidence support a credible AI alternative built on that theory, and how far is it from the focal paper?
- **Distinct AI alternatives.** How many AI alternatives are a different paper from the focal paper (Claude's comparison), consistent with the evidence, and above a minimum fit in their best field?
- **Fit and Novelty.** Claude's judgements, on anchored 0-1 scales. The focal paper and every AI alternative are scored three times in separate calls and the report uses the mean; it also gives how much two scorings of the same one differ (score stability).
- **Distance.** A separate measure from text embeddings, with no model judgement (`src/distance.js`): each AI alternative's distance from the focal paper; the distance of the focal paper and of each AI alternative from the published papers in each field of the corpus, also as a percentile of the published papers' own distances; and which fields their nearest published papers come from. It measures how far apart texts are, not whether an idea is new or belongs in a field, so it is never called Novelty or Fit. The report sets it beside Claude's review, Fit and Novelty.

## Step by step: your own focal paper

Each step says how long it takes and what it costs. Only steps 5, 7 and 8 call Claude, and every case has a spending cap (`--budget`, $80 by default, covering extraction, pilot and full test).

1. **Get the code.** Either [open it in GitHub Codespaces](https://codespaces.new/anilrdoshi/roads-not-taken) (nothing to install; a few minutes to start), or on your own machine, with Node.js 20.12 or later:
   ```bash
   git clone https://github.com/anilrdoshi/roads-not-taken.git
   cd roads-not-taken
   npm ci
   ```
2. **Add your API key and check it.** In Codespaces, add it as a Codespaces secret named `ANTHROPIC_API_KEY` for this repository (GitHub settings, then Codespaces), and reload the codespace. On your machine, `cp .env.example .env` and put your key after `ANTHROPIC_API_KEY=`. Then (free):
   ```bash
   npm run check-key
   ```
   It should say the key works and Claude Opus 5.5 is available.
3. **Build the published corpus** (no key needed; it downloads titles and abstracts from OpenAlex and Crossref):
   ```bash
   npm run build-corpus        # about five minutes
   npm run build-embeddings    # about 25–40 minutes on a laptop CPU, longer on a small codespace; resumes if stopped
   ```
   The embeddings are optional. Without them, scoring retrieves published papers by BM25 alone and the Distance measures are skipped; the report says so.
4. **Add the PDF.** Put the focal paper's PDF in `papers/` (in Codespaces, drag it into the file explorer). If the appendix is a separate file, add it too. This counts the PDF's tokens, for free, and estimates what extraction will cost:
   ```bash
   npm run check-key -- --pdf papers/paper.pdf
   ```
5. **Extract** (about $2 and a few minutes). Pick a short name for the case; its outputs go to `runs/my-paper/`.
   ```bash
   npm run extract -- --case my-paper --pdf papers/paper.pdf     # add --pdf papers/appendix.pdf if the appendix is separate
   ```
   Then read `runs/my-paper/paper/extraction.md`. The **Evidence** section is everything the generator will see: check that it has the data, measures and results, described by how they were measured, and none of the paper's own constructs or theory. The **Framing** section is withheld from the generator; check that it states the paper's question, theory and contribution correctly. The automatic leak check's result is at the end.
6. **Save the focal paper's own abstract** (free). Distance and retrieval use it; it stays in the git-ignored `runs/my-paper/paper/private/`. On macOS, and in Codespaces, this reads it from the PDF; check the printed text. Elsewhere, or if it is not found, paste the abstract into `runs/my-paper/paper/private/abstract.txt`.
   ```bash
   npm run original-abstract -- --case my-paper --pdf papers/paper.pdf
   ```
7. **Run a pilot** (9 AI alternatives, about $5 and 10 minutes). It shows in the explorer, marked as a pilot.
   ```bash
   npm run test-run -- --case my-paper --pilot
   ```
8. **Run the full test** (71 AI alternatives, each reviewed, and the focal paper and every AI alternative scored three times; about $30–35 and roughly an hour). It replaces the pilot in the explorer. A run that stops (network error, spending cap) resumes where it left off when rerun.
   ```bash
   npm run test-run -- --case my-paper
   ```
9. **Explore the results.** The report is in `runs/my-paper/test/summary.md`. For the explorer:
   ```bash
   npm run app        # http://127.0.0.1:4373/ (Codespaces opens it for you)
   ```

**What happens to your focal paper.** The PDF goes only to Anthropic's API, under your own key. Everything the tool writes stays on your machine (or in your codespace), in `runs/` and `ui/data/`, which are git-ignored, so nothing about your focal paper is committed or published unless you share it yourself.

**If something goes wrong.**
- *The key is rejected, or cannot use Claude Opus 5.5:* `npm run check-key` says which. The key needs access to `claude-opus-5-5`.
- *Rate-limit errors (429):* new API accounts start with low limits. Calls are retried automatically; if a run still stops, rerun it with `--concurrency 2` (default 4). It resumes where it stopped.
- *Spending cap reached:* the run stops and says so. Rerun with a higher cap, for example `--budget 120`.
- *No abstract found:* paste it into `runs/my-paper/paper/private/abstract.txt`, then run `npm run distance -- --case my-paper` (free).
- *The explorer is empty or out of date:* `npm run build-explorer`, then reload the page.

## Explore and share the results

The explorer shows each focal paper's anatomy (what was held fixed, what was varied), a map of every AI alternative by the field it fits best and how much of the focal paper it replaced, field and theory charts, the measures and how they are made, and each AI alternative in full beside the focal paper. It is a static site in `ui/` that reads `ui/data/*.json`; each completed pilot or test updates its bundle, and `npm run build-explorer` rebuilds them all (build the corpus first, or cited published papers lose their titles).

To share it, write the explorer for chosen focal papers as one self-contained HTML file. It opens straight from disk, with no server, or can be hosted as a single file:

```bash
npm run export-explorer -- --case my-paper --out my-paper-explorer.html
```

For blind review, `--anonymize` shows each focal paper under a label instead of its title and leaves out its authors and journal (`--case my-paper=Label` for each case). It then checks the file for the title, journal and authors' surnames and writes nothing if any remains. It cannot hide what the evidence itself reveals.

## Requirements

- Node.js 20.12 or later.
- An Anthropic API key with access to Claude Opus 5.5 (`claude-opus-5-5`). Model calls are billed to the key's account; every run has a spending cap.
- Internet access to OpenAlex and Crossref to build the published corpus (no key needed; an optional free `OPENALEX_API_KEY` in `.env` raises the request limit), and once to Hugging Face to download the embedding model (about 420 MB).
- Optional: `pdftotext` (poppler-utils) to read the focal paper's abstract from its PDF on Linux or Windows. Codespaces installs it; macOS does not need it.

## Reproducibility

- **Saved outputs:** every model request and response of a run is in its `calls.jsonl`, and `npm run report -- --case my-paper` rebuilds the report from the saved outputs with no model calls.
- **Reruns:** Claude Opus 5.5 does not accept a temperature or seed, so rerunning a focal paper produces different AI alternatives; the question is whether the conclusions hold. To rerun the test from a saved extraction without the PDF, copy the case folder to a new name without its `test/` and `pilot/` subfolders and `budget.json`, and run `npm run test-run -- --case <copy>`.
- **Corpus:** `npm run build-corpus` rebuilds it from OpenAlex and Crossref. Compare your `corpus/ids.txt` and the `idsSha256` in `corpus/manifest.json` with the committed ones; the databases change slowly, so small differences are expected.
- **Embeddings:** `npm run build-embeddings` embeds the corpus with the model named in `corpus/embeddings.json`; `npm run distance -- --case <case>` then recomputes `distance.json` for a run. Both are deterministic for a given corpus and model, up to floating-point rounding. `npm run validate-embeddings` checks the embeddings against OpenAlex citation links and journal and topic labels, beside BM25 and chance (`corpus/embedding-validation.md`).

## What is and is not in this repository

- **No focal papers.** Your PDFs (`papers/`), runs (`runs/`) and explorer data (`ui/data/`) are git-ignored.
- **No corpus abstracts.** The published corpus is rebuilt by script; `corpus/ids.txt` lists the published papers it contains.
- **Call logs:** a run's `calls.jsonl` replaces PDF contents with their SHA-256 hash and corpus abstracts with the published papers' ids. The full logs, and the focal paper's own abstract, are in the run's `private/` folders.
- **API keys** live only in `.env`, which is git-ignored.

## How it works

1. **Extract** (`src/prompts.js`, `framingTask` and `evidenceTask`). Claude reads the PDF twice, in separate calls.
   - The **framing pass** records the question, conversation, theory, mechanism, interpretation and contribution in the authors' terms. It lists the constructs the focal paper names and tags it with codes from the Academy of Management Journal's submission keywords.
   - The **evidence pass** works from the data, methods and results tables. It describes each variable by how it was measured and records each estimate with its standard error, significance, sample and location. The focal paper's constructs, hypothesis labels and theory names are banned.
   - An **automatic leak check** (`src/leaks.js`) then scans the evidence for any of those terms or for interpretive language. If it finds any, one repair call rewrites the wording. The repair is rejected if a single number, id or significance level changes. The flags, the repair and the unrepaired draft are kept in `extraction.json`.
2. **Generate** (`GENERATION_SYSTEM`). Each AI alternative is a separate call that sees only the evidence. Open runs choose their own field and theory. There are 24 per focal paper: four requests (the best possible paper, a good paper, a publishable paper, a paper publishable in a top journal; `OPEN_AMBITIONS`) crossed with two presentations of the same evidence in the same order (headed sections, or one flat list with results written out in words; `EVIDENCE_FORMATS`), three runs of each. Neither the requests nor the system prompt name a field. Theory runs are given one theory from `config/theories.json`; field runs are aimed at one field and its journals. The rule: keep every reported result as reported. Theorizing a mechanism that was not measured is allowed and labeled. Needing re-analysis or new data is allowed and listed.
3. **Review** (`REVIEW_SYSTEM`). A separate call checks each AI alternative against the evidence and compares it with the focal paper (the prompt's "reference version"), part by part. An AI alternative **fails** only if it contradicts a reported result (wrong outcome, wrong direction, a result not reported, or support stronger than reported). Untested mechanisms, causal language beyond the design, and needs for re-analysis or new data are recorded as **flags**.
4. **Score** (`scoreSystem`). For the focal paper and for each AI alternative, the six most similar published papers in each field are retrieved from the corpus. With the corpus embeddings built this is hybrid retrieval: the BM25 ranking on titles and abstracts and the embedding-similarity ranking are fused by reciprocal rank. Without them it is BM25 alone; each score row records which (`retrieval`). Claude scores Fit to each field and Novelty within the best-fit field on anchored 0-1 scales (the prompt calls what it scores a "paper idea"). It sees no run type and is not told which is the focal paper. The focal paper and every AI alternative are scored three times in separate calls (`--replicates` changes the count); reports use the mean Fit per field and mean Novelty, take the best field from mean Fit, and give the spread between scorings (`src/scores.js`). In each case, the focal paper and its AI alternatives are compared only with published papers up to the focal paper's year.
5. **Distance** (`src/distance.js`, no model calls). The title and abstract of the focal paper, of each AI alternative and of each published paper in the corpus are embedded with `bge-base-en-v1.5` (BAAI; 768 dimensions; run locally through `@huggingface/transformers`). Publisher boilerplate (structured-abstract labels, funding, supplement and copyright notes) is removed first, so published papers do not cluster by publisher (`cleanAbstract` in `src/embeddings.js`). The focal paper is embedded from its own abstract when one is saved (`paper/private/abstract.txt`, git-ignored, never logged), because the extraction's paraphrase is in the third person and sits measurably further from published abstracts; the focal paper's retrieval query uses it too, while Claude is still shown the paraphrase.
   - **Distance from the focal paper:** cosine distance between an AI alternative and the focal paper.
   - **Distance from the published corpus:** the mean distance of the focal paper, or of an AI alternative, to its 10 nearest published papers in a field, and that distance as a percentile of the same distance for up to 1,000 published papers in that field (and in the whole corpus).
   - **Neighbour fields:** the fields of its 20 nearest published papers; the top neighbour field is the one most over-represented relative to its share of the corpus.
   - The report compares these with Claude's family labels (same paper, close variant, different paper) and gives Spearman correlations with Claude's Novelty and Fit.

All calls use Claude Opus 5.5 with adaptive thinking at high effort and JSON-schema structured outputs (`src/llm.js`). Anthropic's server-side refusal fallback is enabled; each logged call records the model that actually answered, so any fallback is visible.

## Configuration

- `config/fields.json`: the five fields and 17 journals. Single-field journals are assigned whole. Administrative Science Quarterly, Organization Science, AMJ and Management Science are split paper by paper using OpenAlex topic labels. The corpus leaves out non-research items, works whose DOI is not the journal's own (`doiPrefixes`), works without an abstract, and split-journal papers whose topic maps to no field; `corpus/manifest.json` counts each. Each field also lists the journals the generation prompts name for its audience (`audienceJournals`).
- `config/theories.json`: all 46 AMJ "Theoretical Perspectives", plus attention-based view, signaling, upper echelons, competitive dynamics, organizational learning, status and reputation. Theory runs use the 27 marked `default`.
- `config/taxonomy.json`: topic and method codes built from the AMJ keyword list by `npm run build-taxonomy`.
- `.env`: your API keys, and optionally `RUNS_DIR` to keep run folders somewhere other than `runs/` (a path relative to this folder).

## Layout

```
.devcontainer/  GitHub Codespaces setup
.github/        workflow: offline tests
config/         fields, journals, theories, keyword codes
corpus/         manifest.json, ids.txt and embeddings.json (records.jsonl and embeddings.bin are rebuilt locally)
papers/         your PDFs (git-ignored)
runs/           your focal papers, one folder each (git-ignored)
scripts/        command-line entry points
src/            pipeline, prompts, schemas, API wrapper, retrieval, embeddings, scores, distance, report
test/           offline tests
ui/             the explorer (a static site); its data bundles in ui/data/ are git-ignored
```
