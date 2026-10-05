# 2026-10-05-20-59-sanity-check-of-the-rewritten-agent

**Note:** sanity check of the rewritten agent

- Commit `f8c9114`, api/ digest `98c8bd41158a`
- Corpus: 43 documents, 576 passages
- Agent model: claude-sonnet-5-5
- Judge: claude-sonnet-5-5, effort medium, facts prompt v2, citations prompt v1
- 10 answers from 10 cases × 1 reps, 0 failed attempts, 10 graded (10 on verified cases)
- Cost: agent $0.1476, judge $0.0786 this grading ($0.0960 uncached)

Scores are the mean over graded answers, with a 95% interval and the count. — means the metric did not apply.

| metric | verified cases | all cases | what it measures |
| --- | --- | --- | --- |
| facts | 94% ±12 (8) | 94% ±12 (8) | Labeled facts the judge finds in the answer |
| numbers | 100% ±0 (8) | 100% ±0 (8) | Labeled figures found in the answer text, checked in code |
| no_errors | 100% ±0 (10) | 100% ±0 (10) | No fact contradicted and no must_not rule broken |
| refusal | 100% ±0 (10) | 100% ±0 (10) | status field matches whether the case expects a refusal |
| refusal_text | 100% ±0 (10) | 100% ±0 (10) | The judge's reading of whether the text declines matches the label |
| retrieval | 100% ±0 (8) | 100% ±0 (8) | Expected documents or FEC records among the retrieved items |
| citation_coverage | 80% ±13 (8) | 80% ±13 (8) | Figures in the answer that some citation's claim covers |
| quote_fidelity | 100% ±0 (7) | 100% ±0 (7) | Passage citations whose quote appears in the retrieved passage |
| citation_support | 97% ±6 (8) | 97% ±6 (8) | Citations whose quote the judge says supports the claim |

## By category (all cases)

| category | n | facts | numbers | no_errors | refusal | refusal_text | retrieval | citation_coverage | quote_fidelity | citation_support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comparison | 1 | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 58% (1) | 100% (1) | 100% (1) |
| fec | 1 | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | — | 100% (1) |
| poll+fec | 1 | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 61% (1) | 100% (1) | 100% (1) |
| poll-fact | 3 | 83% (3) | 100% (3) | 100% (3) | 100% (3) | 100% (3) | 100% (3) | 90% (3) | 100% (3) | 100% (3) |
| prediction | 1 | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 90% (1) | 100% (1) | 100% (1) |
| refusal | 2 | — | — | 100% (2) | 100% (2) | 100% (2) | — | — | — | — |
| survey-metadata | 1 | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 100% (1) | 63% (1) | 100% (1) | 75% (1) |

## Cases

| case | rep | expect | verified | facts | numbers | no_errors | refusal | refusal_text | retrieval | citation_coverage | quote_fidelity | citation_support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [deportations-too-much](#deportations-too-much-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| [texas-senate-poll](#texas-senate-poll-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 71 | 100 | 100 |
| [trump-approval-pew](#trump-approval-pew-0) | 0 | answer | yes | 50 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| [marist-ohio-methodology](#marist-ohio-methodology-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 63 | 100 | 75 |
| [state-senate-margins](#state-senate-margins-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 58 | 100 | 100 |
| [house-prediction](#house-prediction-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 90 | 100 | 100 |
| [talarico-fundraising](#talarico-fundraising-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 100 | — | 100 |
| [iowa-poll-and-money](#iowa-poll-and-money-0) | 0 | answer | yes | 100 | 100 | 100 | 100 | 100 | 100 | 61 | 100 | 100 |
| [gallup-approval](#gallup-approval-0) | 0 | refuse | yes | — | — | 100 | 100 | 100 | — | — | — | — |
| [pennsylvania-2024](#pennsylvania-2024-0) | 0 | refuse | yes | — | — | 100 | 100 | 100 | — | — | — | — |

## Details

### deportations-too-much-0

No problems found.

<details><summary>Answer</summary>

```
About half of U.S. adults (52%) say the Trump administration is doing too much to deport immigrants living in the country illegally. This comes from a Pew Research Center survey of 3,592 U.S. adults conducted April 6-12, 2026. The margin of error is ±1.9 points.

That share is little changed from October 2025, when it was 53%. In the April survey, 31% said the administration is doing about the right amount and 15% said too little.
```

</details>

### texas-senate-poll-0

- Figures with no citation: 6, 8.8

<details><summary>Answer</summary>

```
Talarico (D) leads Paxton (R) 50% to 44% among Texas registered voters in the Marist Poll. It was fielded September 17–20, 2026, with 1,139 registered voters and a margin of error of ±4.4 points.

The 6-point gap is smaller than twice the margin of error, which is about 8.8 points. So Talarico's lead is not clearly outside the margin of error. The poll shows him ahead, but the race is close enough that the lead could be smaller or larger than the poll suggests.

Despite Talarico's lead, 52% of voters overall think Paxton will win the Senate race.
```

</details>

### trump-approval-pew-0

- Fact 0 missing: The answer states 34% approve but does not say it is the lowest mark of his second term; "not stated" for that part.

<details><summary>Answer</summary>

```
Pew's April 2026 survey had Trump's job approval at about 34%. That figure comes indirectly. Pew's July report says Trump's approval rating stands at 34%, while 64% of Americans say they disapprove of his job performance – unchanged since April. So April was roughly 34% approve and 64% disapprove.

The excerpt of the April report itself doesn't state the topline number. That survey was fielded April 20-26, 2026, with 5,103 adults and a margin of error of ±1.6 points.
```

</details>

### marist-ohio-methodology-0

- Figures with no citation: 8, 7.6, 8
- Citation 2 unsupported: The quote gives field dates, sample size, and margin of error but contains no publication date of 2026-09-29.

<details><summary>Answer</summary>

```
The Marist Poll surveyed 1,298 Ohio registered voters from September 24 to 27, 2026. It reached registered voters aged 18 and older in Ohio through a multi-mode design: live-interviewer phone calls, text, or online. The stated margin of error is ±3.8 percentage points. The poll was published 2026-09-29.

The poll's Senate result was Brown (D) 51%, Husted (R) 43%. That is an 8-point gap. The margin of error applies to each number separately, so a lead is clearly outside it only when the gap is about twice the margin, or about 7.6 points. The 8-point gap just clears that threshold.
```

</details>

### state-senate-margins-0

- Figures with no citation: 8, 6, 7.6, 8, 8.8, 8, 6, 8.8

<details><summary>Answer</summary>

```
The Democrat leads by the same 8 points in two states, Iowa and Ohio.

- **Iowa:** Turek (D) 50%, Hinson (R) 42%, with a margin of error of ±4.4 points.
- **Ohio:** Brown (D) 51%, Husted (R) 43%, with a margin of error of ±3.8 points.
- **Texas:** Talarico (D) 50%, Paxton (R) 44%, a 6-point lead, with a margin of error of ±4.4 points.

The margin of error applies to each candidate's number separately, so a lead is clearly outside it only when the gap is about twice the margin.

- **Ohio:** Twice 3.8 is 7.6, so the 8-point lead is clearly outside the margin.
- **Iowa:** Twice 4.4 is 8.8, so the 8-point lead is not clearly outside the margin.
- **Texas:** The 6-point lead is also short of 8.8, so it is not clearly outside the margin either.

Ohio's lead is therefore the most solid of the three.
```

</details>

### house-prediction-0

- Figures with no citation: 12

<details><summary>Answer</summary>

```
I can't predict the outcome. The polls do show Democrats well ahead on the national generic ballot.

- **Latest poll (Marist, Sept. 14–15, 2026):** 53% of registered voters said they'd vote for the Democrat in their district, and 41% said the Republican. The survey has a margin of error of ±3.8 points. The 12-point gap is more than about twice that margin, so the lead is clearly outside it.
- **Earlier polls:** In May, 52% said they were more likely to vote for the Democrat and 42% for the Republican. In November 2025, Democrats led 55% to 41%.
- **Voter expectations:** 52% of registered voters say the Democratic candidate in their district will win, and 44% say the Republican will.

A national generic ballot measures the overall preference for each party. It doesn't tell you who wins individual House districts, and it can't tell you the final result. The search results also have no district-level or seat-count data.
```

</details>

### talarico-fundraising-0

No problems found.

<details><summary>Answer</summary>

```
Through June 30, 2026, James Talarico's campaign reported total receipts of $68,560,930.42. Of that, $65,585,741.88 came from individual contributions. The FEC data also show disbursements of $47,012,775.34 and cash on hand of $21,548,155.08. His principal campaign committee is Talarico for Texas (C00919084).

These figures run only through June 30, 2026. Later fundraising isn't included.
```

</details>

### iowa-poll-and-money-0

- Figures with no citation: 6, 30, 3.9 million, 4.4 million, 570,000, 8, 8.8

<details><summary>Answer</summary>

```
Hinson has out-raised Turek overall and has far more cash on hand. Turek has raised more from individual donors. All figures run through 6/30/2026.

| | Hinson (R) | Turek (D) |
|---|---|---|
| Total receipts | $10,217,845 | $6,276,527 |
| Total disbursements | $5,396,429 | $3,914,213 |
| Cash on hand | $6,749,491 | $2,362,314 |
| Individual contributions | $5,267,629 | $5,835,817 |

- **Receipts:** Hinson has raised about $3.9 million more than Turek.
- **Cash on hand:** Hinson holds about $4.4 million more.
- **Individual contributions:** Turek is ahead by about $570,000. Most of his money comes from individuals, while a larger share of Hinson's total comes from other sources. The FEC data I have doesn't break those sources down.

On the poll, Marist has Turek ahead 50% to 42%, with a margin of error of ±4.4 points. An 8-point gap is a little under twice that margin (about 8.8), so the lead is not clearly outside the margin of error.
```

</details>

### gallup-approval-0

No problems found.

<details><summary>Answer</summary>

```
The search results don't include any Gallup poll, so I can't say what Gallup's latest poll found on Trump's approval.

The results do include other pollsters:
- **Marist (June 8–11, 2026):** Trump's approval is 36%, the lowest of his second term, and disapproval is 59%. The poll surveyed 1,340 adults with a margin of error of ±3 points.
- **Pew (April 20–26, 2026):** Trump's job approval stands at 34%, the lowest mark of his second term. The poll surveyed 5,103 adults with a margin of error of ±1.6 points.
```

</details>

### pennsylvania-2024-0

No problems found.

<details><summary>Answer</summary>

```
I can't answer this one. The search results don't include 2024 election results for Pennsylvania, and the FEC tools only cover campaign finance. Official election results are outside what I handle.

The Pew results only give national figures for 2024 voters, not state-level ones.
```

</details>
