#!/usr/bin/env python3
"""
Regression tests for the query-plan extractor.

Every assertion here corresponds to a bug that actually shipped and was caught,
or to a fact that a correct answer depends on. Standard library only.

    python tests/test_extract.py

Needs a directory of .sqlplan fixtures. Set PLANS_DIR, or it falls back to the
PerformanceStudio examples. Tests that need a fixture skip if it is missing, so
this stays runnable by anyone who clones the repo.
"""

import os
import pathlib
import subprocess
import sys
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
EXTRACT = REPO / "plugins/sqlserver-query-plans/skills/query-plan-analysis/scripts/extract.py"
PLANS = pathlib.Path(
    os.environ.get("PLANS_DIR", r"C:\GitHub\PerformanceStudio\.internal\examples")
)


def digest(plan_name, *args):
    plan = PLANS / plan_name
    if not plan.exists():
        raise unittest.SkipTest(f"fixture not present: {plan}")
    r = subprocess.run(
        [sys.executable, str(EXTRACT), str(plan), *args],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise AssertionError(f"extract.py failed on {plan_name}:\n{r.stderr}")
    return r.stdout


class Timing(unittest.TestCase):
    """Self-time attribution. Getting this wrong produces confident, inverted answers."""

    def test_self_time_crowns_the_spool_not_the_root(self):
        # Ranking by raw cumulative ActualElapsedms would always crown the root
        # node. The real hot operator is the Eager Index Spool at node 16.
        out = digest("eager-index-spool.sqlplan")
        table = out.split("TOP 10 OPERATORS")[1].splitlines()
        first_row = next(l for l in table if " ms " in l and "node" not in l.lower())
        self.assertIn("Index Spool", first_row)
        self.assertIn("16", first_row)

    def _top_row(self, out):
        """First data row of the ranked operator table."""
        lines = out.splitlines()
        header = next(i for i, l in enumerate(lines) if l.strip().startswith("self elapsed"))
        return next(l for l in lines[header + 1:] if " ms " in l and "read " not in l)

    def test_coordinator_thread_is_not_mistaken_for_self_time(self):
        # Thread 0 is the coordinator: no rows, and an elapsed equal to the whole
        # parallel branch's wall clock. Including it handed every operator in the
        # branch the branch's entire duration. In bad_time.sqlplan that made three
        # separate operators each report 948 ms of a 949 ms query.
        out = digest("bad_time.sqlplan")
        top = self._top_row(out)
        self.assertIn("16", top, f"expected node 16 to lead, got: {top!r}")
        for ms in ("948 ms", "949 ms", "595 ms"):
            self.assertNotIn(ms, self._top_row(out))

    def test_hot_operator_reports_nonzero_self_cpu(self):
        # The coordinator burns no CPU, so leaving it in the per-thread max
        # underflowed the workers' real self CPU to zero.
        out = digest("complexity-batch-mode.sqlplan")
        top = self._top_row(out)
        cpu = top.split("ms")[1].strip().split()[0].replace(",", "")
        self.assertGreater(int(cpu), 0, f"self CPU underflowed to zero: {top!r}")

    def test_batch_mode_operator_keeps_its_standalone_cpu(self):
        # Batch mode reports self time directly; subtracting children underflows it.
        # Note: complexity-batch-mode.sqlplan is row mode throughout despite its
        # name. Verify against a plan that genuinely has a batch-mode operator.
        out = digest("20260415_1.sqlplan", "--node", "10")
        self.assertIn("execution mode   : Batch", out)
        cpu_line = next(l for l in out.splitlines() if "self CPU" in l)
        self.assertNotIn(": 0 ms", cpu_line)

    def test_udf_time_is_surfaced_as_a_share_of_elapsed(self):
        # A scalar UDF's time is attributed to no operator. It must be called out.
        out = digest("functions-slow-scalar.sqlplan")
        self.assertIn("UDF time", out)
        self.assertIn("scalar UDFs account for 99.99% of elapsed time", out)
        self.assertIn("per invocation", out)


class Cardinality(unittest.TestCase):
    def test_estimates_are_normalized_per_execution(self):
        # ActualRows is a total; EstimateRows is per execution. Comparing them
        # raw makes every nested-loop inner side look catastrophically wrong.
        out = digest("eager-index-spool.sqlplan")
        self.assertIn("CARDINALITY SKEW (per execution)", out)
        self.assertIn("/exec", out)

    def test_ce_guess_fingerprint_does_not_name_the_guess(self):
        # The guess fractions differ between cardinality estimator versions.
        # Report the fingerprint; never label it "the 30% equality guess".
        out = digest("dba-days-update.sqlplan", "--node", "14")
        self.assertIn("known fixed-guess fraction", out)
        for wrong in ("equality guess", "inequality guess", "compound predicate guess"):
            self.assertNotIn(wrong, out)


class Spools(unittest.TestCase):
    def test_eager_index_spool_suppresses_missing_index_note(self):
        out = digest("eager-index-spool.sqlplan")
        self.assertIn("eager INDEX spool is present", out)
        self.assertIn("does NOT mean no", out)

    def test_eager_table_spool_is_not_an_index_spool(self):
        # The detector matched "Spool" + "Eager", so an eager TABLE spool --
        # ordinary Halloween protection in any update plan -- was told it needed
        # an index. Table Spool and Index Spool are different operators.
        out = digest("dba-days-update.sqlplan")
        self.assertNotIn("eager INDEX spool is present", out)


class Warnings(unittest.TestCase):
    def test_no_join_predicate_carries_its_caveat_inline(self):
        out = digest("missing-join-predicate.sqlplan")
        self.assertIn("No join predicate", out)
        self.assertIn("frequently benign", out)

    def test_no_join_predicate_row_check_admits_when_inconclusive(self):
        # Both inputs are 1 row here (a TOP row goal), so multiplication cannot
        # be observed. Saying "consistent with a cross join" would be a wrong
        # verdict stated confidently.
        out = digest("missing-join-predicate.sqlplan")
        self.assertIn("row check", out)
        self.assertIn("INCONCLUSIVE", out)

    def test_both_join_inputs_shown_so_the_discriminator_is_readable(self):
        # Transitive predicate elimination is diagnosed from the join's INPUTS:
        # are both pinned to the same constant?
        out = digest("missing-join-predicate.sqlplan")
        preds = out.split("PREDICATES ON CITED OPERATORS")[1]
        self.assertEqual(preds.count("22656"), 2, "expected both inputs pinned to 22656")


class Rewrites(unittest.TestCase):
    def test_cte_re_expansion_is_surfaced(self):
        # A non-recursive CTE is expanded once per reference. Five references to
        # a CTE over dbo.Posts means five scans of dbo.Posts.
        out = digest("cte-performance.sqlplan")
        self.assertIn("SAME OBJECT ACCESSED MORE THAN ONCE", out)
        self.assertIn("5 accesses", out)
        self.assertIn("dbo.Posts", out)

    def test_same_object_note_does_not_assert_a_cause(self):
        # A self-join looks identical to a re-expanded CTE. eager-index-spool
        # genuinely self-joins Posts. The note must not claim it is a CTE.
        out = digest("eager-index-spool.sqlplan")
        self.assertIn("SAME OBJECT ACCESSED MORE THAN ONCE", out)
        self.assertIn("A self-join looks the", out)

    def test_table_variable_serial_reason_is_visible(self):
        out = digest("cte-vs-temp-table-variable.sqlplan")
        self.assertIn("TableVariableTransactionsDoNotSupportParallelNestedTransaction", out)
        self.assertIn("(serial)", out)  # DOP 0 and DOP 1 both mean one thread


class Robustness(unittest.TestCase):
    def test_utf16_plan_parses(self):
        # .sqlplan is UTF-16. grep silently matches nothing on these.
        out = digest("convert-implicit.sqlplan")
        self.assertIn("Implicit Conversion".lower(), out.lower())

    def test_plan_that_lies_about_its_encoding_parses(self):
        # UTF-8 bytes still declaring encoding="utf-16", from a re-save.
        out = digest("bad_time.sqlplan")
        self.assertIn("STATEMENT", out)

    def test_invalid_plan_fails_with_a_readable_message(self):
        plan = PLANS / "garbage.sqlplan"
        if not plan.exists():
            self.skipTest("fixture not present")
        r = subprocess.run(
            [sys.executable, str(EXTRACT), str(plan)], capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 1)
        self.assertIn("not a valid showplan", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_every_fixture_parses(self):
        plans = sorted(PLANS.glob("*.sqlplan")) if PLANS.exists() else []
        if not plans:
            self.skipTest(f"no fixtures in {PLANS}")
        failures = []
        for p in plans:
            if p.name == "garbage.sqlplan":
                continue  # deliberately invalid
            r = subprocess.run(
                [sys.executable, str(EXTRACT), str(p)], capture_output=True, text=True
            )
            if r.returncode != 0:
                failures.append(p.name)
        self.assertEqual(failures, [], f"{len(failures)} plans failed to parse")


class Docs(unittest.TestCase):
    """The skill's prose is the product. Guard the claims that were wrong once."""

    SKILL = REPO / "plugins/sqlserver-query-plans/skills/query-plan-analysis"

    def _read(self, name):
        return (self.SKILL / name).read_text(encoding="utf-8")

    def test_no_mislabeled_ce_guesses_in_prose(self):
        for f in self.SKILL.rglob("*.md"):
            text = f.read_text(encoding="utf-8")
            for wrong in ("30% equality guess", "10% inequality guess"):
                self.assertNotIn(wrong, text, f"{f.name} names a CE guess")

    def test_cte_is_not_called_equivalent_to_a_temp_table(self):
        text = self._read("references/rewrites.md")
        self.assertIn("not materialized", text)
        self.assertIn("re-executed", text)

    def test_table_variable_one_row_claim_is_scoped_to_pre_deferred_compilation(self):
        # "A table variable always estimates 1 row" is false under deferred
        # compilation (2019+, compat 150).
        text = self._read("references/rewrites.md")
        self.assertIn("deferred compilation", text)
        self.assertIn("real", text.lower())
        self.assertNotIn("always estimates 1 row", text)

    def test_table_variables_are_not_described_as_in_memory(self):
        text = self._read("references/rewrites.md")
        self.assertIn("do not live in memory", text)

    def test_skill_forbids_relying_on_query_text(self):
        text = self._read("SKILL.md")
        self.assertIn("Do not rely on the query text", text)

    def test_all_three_construct_pairs_are_distinguished(self):
        # Six constructs, three pairings people conflate. Each needs its own
        # section, because the model will otherwise assert they are equivalent.
        text = self._read("references/rewrites.md")
        for heading in (
            "## A CTE is not a temp table",
            "## A table variable is not a lightweight temp table",
            "## A parameter is not a local variable",
        ):
            self.assertIn(heading, text, f"missing section: {heading}")

    def test_local_variables_are_not_described_as_appearing_in_parameterlist(self):
        text = self._read("references/rewrites.md")
        self.assertIn("never appear in `ParameterList`", text)

    def test_local_variable_range_predicate_is_not_called_a_density_estimate(self):
        # Density is the equality fallback. Range predicates get a fixed guess.
        # dba-days-update.sqlplan proves it: @hkey/@bmax in a range land on 16.4%.
        text = self._read("references/cardinality.md")
        self.assertIn("for a range\npredicate, on a fixed guess", text)

    def test_parameter_note_does_not_blame_a_local_variable(self):
        # Locals never reach ParameterList, so a missing compiled value there
        # cannot mean "local variable".
        src = (self.SKILL / "scripts/extract.py").read_text(encoding="utf-8")
        self.assertNotIn("not sniffed - local variable", src)


if __name__ == "__main__":
    if not EXTRACT.exists():
        sys.exit(f"extractor not found at {EXTRACT}")
    unittest.main(verbosity=2)
