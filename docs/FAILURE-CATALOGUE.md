# Failure catalogue

Every entry here is a bug that reached production in a real installation. They
are recorded because the *shape* of each one generalises, and because a
comment explaining a failure is worth more than a comment explaining an
intention.

Findings are from a single operator's deployment over roughly two weeks. Treat
the rates as one calibration point, not as a benchmark.

---

## 1. Capitalisation decided grounding

**Symptom.** `Are you able to change your Humor setting to 100?` produced a web
search about the agent's own configuration.

**Cause.** A proper-noun detector treated any capitalised non-common word as a
named external entity, and a named external entity routed to the web tier.
"Humor" is capitalised because it is the name of a setting.

**Blast radius.** 46% of turns tripped this heuristic; 43% were routed to the
web *by it alone*. Two more visible failures shared the cause: `Good one`
(capitalised common word) failed closed on a two-word reaction to a joke, and a
capitalised contraction opening a hypothetical produced an encyclopedia entry
about a trolley problem.

**Fix.** Normalise contractions before lookup and skip short all-caps tokens
as acronyms. The actual fix, though, was to stop letting the heuristic
*promote* a turn to a grounded tier at all.

**The generalisable part.** A single feature that can unilaterally promote to
enforcement will eventually promote something absurd. Features should vote;
they should not decide.

---

## 2. The contract owned turns it should not have

**Symptom.** 29% of ordinary conversational turns ended in *"I could not
verify that, so I will not answer."* Sign-offs, jokes, and reactions were among
them.

**Cause.** The contract decided what evidence an answer needed before the
answer existed. That is prediction over unbounded user input, and the
classifier worked *correctly* on turns it should never have owned.

**Fix.** Advisory routing. Hard enforcement only where semantics are
unambiguous.

**The generalisable part.** Jurisdiction errors look like judgement errors and
get fixed as judgement errors, which is why the rule list grew to 15 branches
without getting better. Ask "should this rule own this turn at all" before
asking "did this rule decide correctly".

---

## 3. A hypothetical became a search for someone's address

**Symptom.** `What if I told you that I am <famous actor>?` produced a web
search for that person's private residence.

**Cause.** Two failures stacked. The turn read as a correction (a claim
conflicting with stored context), and corrections re-grounded. Nothing
distinguished "locate a private individual" from any other search.

**Fix.** Assertion-mode filtering excludes questions, hypotheticals, and
quotations from fact detection. Separately, `src/sensitive.js` blocks searches
whose purpose is to locate a private residence, personal contact details, or
identity via residential information, with IP and MAC addresses explicitly
exempt, since those are ordinary infrastructure questions.

**The generalisable part.** "Could this tool call harm a third party who is not
in this conversation?" is a different question from "is this tool call
relevant", and needs its own gate. Relevance gates do not catch it.

---

## 4. Recomputing the verdict on a rebuilt prompt

**Symptom.** A turn escalated its own requirements on each revision pass.

**Cause.** `before_prompt_build` fires again when the harness rebuilds the
prompt. The rebuilt text contains the plugin's own injected requirement, not
the user's turn. Classifying it derived the obligation from the wrong string.

**Fix.** A per-turn nonce. The verdict and hard-trigger decision are computed
once, when the nonce is new, and reused on rebuilds.

**Fallen into twice**, the second time while adding a new hard trigger,
immediately below a comment describing the trap.

---

## 5. A correction became a mandatory memory tier

**Symptom.** Ordinary corrections compelled a memory search before the agent
would answer.

**Cause.** Two different invariants were conflated:

- *A correction must be resolved before a durable fact is written.* True.
- *Every correction must run a memory search.* Not true, and much more
  expensive.

**Fix.** Corrections became a scope on the persistence path, not a retrieval
tier. `requiredTool` is `null` in every case; the user is the authority on
their own world, so their assertion is the evidence.

**The generalisable part.** When a rule feels too aggressive, check whether it
is enforcing the invariant you meant or a stronger one that implies it.

---

## 6. A failed write reported a retrieval failure

**Symptom.** When persisting a fact failed, the conversational answer was
replaced with the grounding fail-closed sentence.

**Cause.** One latch served both gates.

**Fix.** A persistence failure withholds the write and says so. It is not a
grounding failure, and the turn was never bound to a retrieval tier.

---

## 7. The prompt and the code disagreed about their shared sentence

**Symptom.** None visible. The fail-closed sentence in the prompt files had
been reworded; the plugin still compared against the old wording.

**Cause.** Two sources of truth for one string.

**Fix.** A test hashes both and asserts equality. Note that the *first* version
of that check was blind to its own outcome. It compared, but nothing consumed
the comparison.

**The generalisable part.** A consistency check that cannot fail is worse than
no check, because it is load-bearing in your confidence and nowhere else.

---

## 8. Enforcement rate mistaken for false-positive rate

**Symptom.** "The gate fires on 61% of turns" was treated as the error rate. It
is not; it is the enforcement rate, and it says nothing about correctness.

**Fix.** False positives live in the **disagreement set**: turns where the
chain would have compelled a tool and a free model reached for nothing. The
converse set, where the model searched and the chain saw nothing, is the
false-negative pool. Both are small enough to hand-label weekly.

---

## 9. Comparing two models across two code versions

**Symptom.** One model looked "dramatically better" in a transcript.

**Cause.** The transcripts spanned a plugin change. The comparison was
confounded and the conclusion was withdrawn.

**Fix.** Behaviour epochs plus separate prompt, ruleset, and config hashes on
every record. When the measured comparison was finally run within one epoch,
the two models differed by 4 words of median length and 1 percentage point of
voice-gate firing. The visible difference was latency, not quality.

**The generalisable part.** Any corpus that cannot tell you which code produced
each record will eventually be used to justify a wrong conclusion.

---

## 10. Restart checks that matched the wrong process

**Symptom.** A code change appeared not to take effect. Twice, a restart was
reported as confirmed when the gateway had not restarted.

**Cause.** A `pgrep` pattern loose enough to match an unrelated process.

**Fix.** Identify the gateway by the process bound to its port.

**The generalisable part.** A verification step that can pass for the wrong
reason will eventually pass for the wrong reason, and it will do so on the one
occasion you needed it to be right.
