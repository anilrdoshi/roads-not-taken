# Roads Not Taken

Every empirical paper is one realization of many papers its evidence could have supported. This tool takes a completed paper, the **focal paper**, holds its evidence fixed (setting, data, measures, design and reported results), and asks Claude to write **AI alternatives** built on the same evidence: freely, under a different theory (fine perturbation) or for a different field (coarse perturbation). It then checks each AI alternative against the evidence, compares it with the focal paper, and scores the focal paper and every AI alternative for overall fit to five business-school fields (whether it belongs in the field, combined with whether its theory predicts the evidence) and for novelty within the best-fit field, against the **published corpus** of journal papers. Separately, it measures distance from text embeddings: how far each AI alternative's text is from the focal paper's, and how far the focal paper and each AI alternative are from the published papers in the corpus.

The tool works on one focal paper at a time. You bring the focal paper (a PDF) and an Anthropic API key; the tool builds the published corpus, runs the test and shows the results in an explorer on your machine. Each focal paper you run is a **case**: a folder in `runs/`, under a short name you choose, that holds its extraction, pilot, full test, reports and spending.

## Quick start

| To | Do this | You need |
|---|---|---|
| See results for four example focal papers | [Open the example explorer](https://anilrdoshi.github.io/roads-not-taken/example/roads-not-taken-explorer.html) in your browser, or download it from [`example/`](example/) and open it from disk | A browser |
| Try the tool without installing anything | [Open it in GitHub Codespaces](https://codespaces.new/anilrdoshi/roads-not-taken). Dependencies install and the explorer opens on port 4373, empty until you run a focal paper. | A GitHub account |
| Install it on your machine | Clone the repository ([step 1](#set-up-once)), `npm ci`, then `npm run app` and open http://127.0.0.1:4373/ | Node.js 20.12 or later |
| Check that it works | `npm run check` (offline tests with a mock model) | Nothing more |
| Run it on your own focal paper | Follow [Step by step](#step-by-step-your-own-focal-paper). Extraction costs about $2, a pilot about $7 and the full test about $45–55. | An Anthropic API key with access to Claude Opus 5.5 |

## What it measures

- **Convergence.** Open runs get only the evidence and are asked for an AI alternative in any field, with any theory. The request and the format of the evidence vary from run to run, so agreement among them is not an artifact of one wording. How often do they come back to the focal paper (same paper, close variant, or different paper)?
- **Field reach.** For each of five fields (strategy and organization theory, organizational behavior, information systems, marketing, operations), how well does the focal paper fit, and how well does the highest-fit AI alternative aimed at that field fit? How many parts of the focal paper did it replace, and does it need new data?
- **Theory reach.** For each of 27 theories, can the evidence support a credible AI alternative built on that theory: how well does the theory predict the evidence, how well does the AI alternative fit, and how far is it from the focal paper?
- **Distinct AI alternatives.** How many AI alternatives are a different paper from the focal paper (Claude's comparison), consistent with the evidence, and have an overall fit in their best field at least the focal paper's, less scoring noise?
- **Overall fit and novelty.** Claude's judgements. Overall fit has two parts, judged in separate calls: **field fit** (would editors in a field see it as theirs?) and **evidence fit** (does its theory predict the reported results, rather than merely accommodate them?). Overall fit in a field is their geometric mean, so a paper needs both. The prompts give Claude anchored 0-1 scales to guide its judgements, but the scores are not assumed to come back on those scales: the bands are there to draw out variation, so each score is read as relative, against the focal paper and the other AI alternatives, not as an absolute position. Evidence fit is strict, which makes this matter most for overall fit. The focal paper and every AI alternative are scored three times in separate calls and the report uses the mean; it also gives how much two scorings of the same one differ (score stability).
- **Distance.** A separate measure from text embeddings, with no model judgement (`src/distance.js`): each AI alternative's distance from the focal paper; the distance of the focal paper and of each AI alternative from the published papers in each field of the corpus, also as a percentile of the published papers' own distances; and which fields their nearest published papers come from. It measures how far apart texts are, not whether an idea is new or belongs in a field, so it is never called novelty or fit. The report sets it beside Claude's review, overall fit and novelty.

## Step by step: your own focal paper

Steps 1–3 set the tool up and are done once. Steps 4–8 are repeated for each focal paper. Each step says how long it takes and what it costs. Only steps 5, 6 and 7 cost money, billed to your key, and each case has a spending cap that covers its extraction, pilot and full test together (`--budget`, $80 by default).

### Set up (once)

1. **Get the code.** Either:
   - **In GitHub Codespaces** (nothing to install): [open it](https://codespaces.new/anilrdoshi/roads-not-taken). It takes a few minutes to start, installs everything and opens the explorer. Type the commands below in the codespace's terminal.
   - **On your own machine**, with Node.js 20.12 or later:
     ```bash
     git clone https://github.com/anilrdoshi/roads-not-taken.git
     cd roads-not-taken
     npm ci
     ```
     Type the commands below in this `roads-not-taken` folder.
2. **Add your API key and check it** (free). Copy the example settings file:
   ```bash
   cp .env.example .env
   ```
   Open `.env` (in Codespaces, from the file explorer) and put your key after `ANTHROPIC_API_KEY=`. The file is git-ignored, so the key is never committed. In Codespaces you can instead add the key as a Codespaces secret named `ANTHROPIC_API_KEY` (GitHub settings, then Codespaces) and reload the codespace. Then:
   ```bash
   npm run check-key
   ```
   It should say the key works and Claude Opus 5.5 is available. If not, see [If something goes wrong](#if-something-goes-wrong).
3. **Build the published corpus** (free, no key needed; about 30–45 minutes, mostly unattended). The first command downloads the published papers' titles and abstracts from OpenAlex and Crossref. The second embeds them with a local model, which it downloads the first time (about 420 MB):
   ```bash
   npm run build-corpus        # about five minutes
   npm run build-embeddings    # about 25–40 minutes on a laptop CPU, longer on a small codespace
   ```
   If the embedding build stops, run it again; it resumes where it stopped. While it runs you can go on with steps 4–5 in a second terminal, but let it finish before step 6. The embeddings are optional: a run started without them retrieves published papers by BM25 alone and skips the distance measures, and its report says so.

### For each focal paper

4. **Add the PDF** (free). Create a `papers/` folder:
   ```bash
   mkdir -p papers
   ```
   Put the focal paper's PDF in it (in Codespaces, drag the PDF onto the folder in the file explorer). If the appendix is a separate PDF, put it there too. Then count the PDF's tokens, for free, to estimate what extraction will cost:
   ```bash
   npm run check-key -- --pdf papers/paper.pdf
   ```
   Here and in the steps below, replace `papers/paper.pdf` with your file's name, in quotes if it contains spaces. For a separate appendix, add `--pdf papers/appendix.pdf`.
5. **Extract** (about $2 and a few minutes). Choose a name for the case, using letters, digits and hyphens (for example `my-paper`). Its outputs go to `runs/my-paper/`, and every step below uses the same name.
   ```bash
   npm run extract -- --case my-paper --pdf papers/paper.pdf
   ```
   It also saves the focal paper's own abstract, read from the first PDF, to the git-ignored `runs/my-paper/paper/private/abstract.txt`. Distance and the focal paper's retrieval query use it; Claude is never shown it. Reading it needs macOS, Codespaces or `pdftotext` (see [Requirements](#requirements)). Check the printed abstract against the PDF. If the command cannot find it, paste it into that file by hand before step 6.

   Then read `runs/my-paper/paper/extraction.md`. The **Evidence** section is everything the generator will see: check that it has the data, measures and results, described by how they were measured, and none of the paper's own constructs or theory. The **Framing** section is withheld from the generator; check that it states the paper's question, theory and contribution correctly. The automatic leak check's result is at the end. If the extraction is wrong, run the command again (about $2 more); the new extraction replaces it. Do this before step 6, because every AI alternative is built from the extraction.
6. **Run a pilot** (9 AI alternatives; about $7 and 15 minutes). It runs every stage of the test on a small scale, so problems show before you pay for the full test.
   ```bash
   npm run test-run -- --case my-paper --pilot
   ```
   Check that its last lines say `Complete.`, that its report (`runs/my-paper/pilot/summary.md`) says `Failures: 0`, and that the AI alternatives read sensibly in the explorer, where the pilot is marked as one.
7. **Run the full test** (71 AI alternatives; about $45–55 and roughly an hour and a half). Each AI alternative is reviewed, and the focal paper and every AI alternative are scored three times for field fit and novelty and three times for evidence fit. The pilot's AI alternatives are not reused, and the full test replaces the pilot in the explorer.
   ```bash
   npm run test-run -- --case my-paper
   ```
   Keep your machine awake, or the codespace open, while it runs. If it is interrupted, or its report lists failures, run the same command again: it keeps what is done and runs only what is missing. If it stopped at the spending cap, add a higher cap, for example `--budget 120`.
8. **Explore the results.** The report is `runs/my-paper/test/summary.md`. In Codespaces the explorer is already running: reload its tab, or open port 4373 from the Ports panel. On your machine, start it and open http://127.0.0.1:4373/:
   ```bash
   npm run app
   ```

### What happens to your focal paper

The PDF goes only to Anthropic's API, under your own key. Everything the tool writes stays on your machine (or in your codespace), in `runs/` and `ui/data/`, which are git-ignored, so nothing about your focal paper is committed or published unless you share it yourself.

### If something goes wrong

- *The key is rejected, or cannot use Claude Opus 5.5:* `npm run check-key` says which. The key needs access to `claude-opus-5-5`.
- *Rate-limit errors (429):* new API accounts start with low limits. Calls are retried automatically; if a run still stops, rerun it with `--concurrency 2` (default 4). It resumes where it stopped.
- *Spending cap reached:* the run stops and says so. The cap is for the whole case, so rerun with a higher one, for example `--budget 120`.
- *The report lists failures:* rerun the same command. Only what failed runs again.
- *The test ran before the abstract was saved, or before the embeddings were built:* paste the abstract into `runs/my-paper/paper/private/abstract.txt` or do step 3, then run `npm run distance -- --case my-paper` (free) to recompute the distance measures. Scoring keeps the retrieval it ran with.
- *`npm run app` says the address is already in use:* the explorer is already running (Codespaces starts it for you). Reload its tab instead.
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
- Optional: `pdftotext` (poppler-utils), for extraction to read the focal paper's own abstract from its PDF on Linux or Windows; without it, paste the abstract by hand. Codespaces installs it; macOS does not need it.

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
   - The focal paper's **own abstract** is read from the PDF, with no model call, and saved privately for retrieval and distance (step 6 below); Claude is shown only the framing pass's paraphrase.
2. **Generate** (`GENERATION_SYSTEM`). Each AI alternative is a separate call that sees only the evidence. Open runs choose their own field and theory. There are 24 per focal paper: four requests (the best possible paper, a good paper, a publishable paper, a paper publishable in a top journal; `OPEN_AMBITIONS`) crossed with two presentations of the same evidence in the same order (headed sections, or one flat list with results written out in words; `EVIDENCE_FORMATS`), three runs of each. Neither the requests nor the system prompt name a field. Theory runs are given one theory from `config/theories.json`; field runs are aimed at one field and its journals. The rule: keep every reported result as reported. Theorizing a mechanism that was not measured is allowed and labeled. Needing re-analysis or new data is allowed and listed.
3. **Review** (`REVIEW_SYSTEM`). A separate call checks each AI alternative against the evidence and compares it with the focal paper (the prompt's "reference version"), part by part. An AI alternative **fails** only if it contradicts a reported result (wrong outcome, wrong direction, a result not reported, or support stronger than reported). Untested mechanisms, causal language beyond the design, and needs for re-analysis or new data are recorded as **flags**.
4. **Score** (`scoreSystem`). For the focal paper and for each AI alternative, the six most similar published papers in each field are retrieved from the corpus. With the corpus embeddings built this is hybrid retrieval: the BM25 ranking on titles and abstracts and the embedding-similarity ranking are fused by reciprocal rank. Without them it is BM25 alone; each score row records which (`retrieval`). Claude scores field fit to each field and novelty within the best-fit field on anchored 0-1 scales (the prompt calls what it scores a "paper idea", and field fit "Fit"). The scales and their bands guide Claude; the scores are not assumed to come back on them, so they are read relative to the focal paper and the other AI alternatives, not as absolute positions. It sees no run type and is not told which is the focal paper. The focal paper and every AI alternative are scored three times in separate calls (`--replicates` changes the count); reports use the mean field fit per field and mean novelty, take the best field from mean field fit, and give the spread between scorings (`src/scores.js`). In each case, the focal paper and its AI alternatives are compared only with published papers up to the focal paper's year.
5. **Evidence fit** (`EVIDENCE_FIT_SYSTEM`). A separate call sees the evidence and the paper (question, theory, mechanism, hypotheses as plain statements, interpretation, contribution) and judges how well its theory *predicts* the reported results. Every AI alternative is written with the results in view, so hypotheses fitted to them do not count as predictions: the judge asks whether someone who held the theory, knowing the setting and design but not the results, would have expected them. It classifies up to eight central results as predicted, accommodated, unexplained or in tension, notes whether a substantive rival predicts each as well, and leaves out doubts about the data or design, which apply to every theory alike. A misstated result does not lower the score by itself; the review's evidence check records it. Like field fit, its anchored 0-1 scale guides Claude and the score is read as relative; it is scored three times, blind to run type and to which is the focal paper (`evidence-fit.jsonl`).
   - **Overall fit** in a field is the geometric mean of field fit and evidence fit. Field fit alone could not tell theories apart: an AI alternative built on firm-level evidence for a strategy audience is a strategy paper whatever its theory. Evidence fit is strict, and a stricter judge lowers every paper's overall fit by the same factor, so overall fit is read against the focal paper's and the other AI alternatives'.
   - **Distinct AI alternatives** are a different paper from the focal paper, consistent with the evidence, with an overall fit in their best field at least the focal paper's less scoring noise: two standard errors of the difference between two papers' mean overall fit, estimated from how much overall fit varies between scorings of the same paper (`fitNoise` in `src/scores.js`). The report also gives the count with AI alternatives that contradict a reported result included.
6. **Distance** (`src/distance.js`, no model calls). The title and abstract of the focal paper, of each AI alternative and of each published paper in the corpus are embedded with `bge-base-en-v1.5` (BAAI; 768 dimensions; run locally through `@huggingface/transformers`). Publisher boilerplate (structured-abstract labels, funding, supplement and copyright notes) is removed first, so published papers do not cluster by publisher (`cleanAbstract` in `src/embeddings.js`). The focal paper is embedded from its own abstract, which extraction saves from the PDF (`paper/private/abstract.txt`, git-ignored, never logged; the paraphrase is used if none is saved), because the extraction's paraphrase is in the third person and sits measurably further from published abstracts; the focal paper's retrieval query uses it too, while Claude is still shown the paraphrase.
   - **Distance from the focal paper:** cosine distance between an AI alternative and the focal paper.
   - **Distance from the published corpus:** the mean distance of the focal paper, or of an AI alternative, to its 10 nearest published papers in a field, and that distance as a percentile of the same distance for up to 1,000 published papers in that field (and in the whole corpus).
   - **Neighbour fields:** the fields of its 20 nearest published papers; the top neighbour field is the one most over-represented relative to its share of the corpus.
   - The report compares these with Claude's family labels (same paper, close variant, different paper) and gives Spearman correlations with Claude's novelty and field fit.

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
example/        the explorer of four example focal papers, anonymized (one HTML file)
corpus/         manifest.json, ids.txt and embeddings.json (records.jsonl and embeddings.bin are rebuilt locally)
papers/         your PDFs (git-ignored; you create it in step 4)
runs/           your cases, one folder per focal paper (git-ignored; created by the first extraction)
scripts/        command-line entry points
src/            pipeline, prompts, schemas, API wrapper, retrieval, embeddings, scores, distance, report
test/           offline tests
ui/             the explorer (a static site); its data bundles in ui/data/ are git-ignored
```
