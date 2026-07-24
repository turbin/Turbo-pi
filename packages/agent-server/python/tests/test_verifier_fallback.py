"""Unit tests for verifier text-fallback and extract_tag_distribution compatibility.

Tests cover the dual-path logic in Verifier._score_once (SPEC: P3-1 real-LLM verification):
- Text-fallback via _extract_scores_from_text when logprobs are unavailable/empty
- Expected-value path via expected_from_top_logprobs when logprobs are present
- extract_tag_distribution dict/list dual-input compatibility
- Boundary and error cases for all paths
"""
from __future__ import annotations

import math

import pytest

from verification_selection.llm_client import MockLLM, MockResponse
from verification_selection.testing import letter_distribution, score_response
from verification_selection.verifier import (
	Criterion,
	LetterScale,
	ScoreExtractionError,
	Verifier,
	expected_from_top_logprobs,
	extract_tag_distribution,
)

# ══════════════════════════════════════════════════════════════════════════════
# Test helpers
# ══════════════════════════════════════════════════════════════════════════════


def _mk_text(letter_a: str, letter_b: str) -> str:
	"""Response text containing <score_A>/<score_B> tags (typical verifier output)."""
	return (
		"<reasoning>Trajectory A is more complete than B.</reasoning>\n"
		f"<score_A> {letter_a} </score_A>\n"
		f"<score_B> {letter_b} </score_B>\n"
	)


def _verifier(mock: MockLLM, *, G: int = 5) -> Verifier:
	"""Create a Verifier with reduced G (A-E) for faster/deterministic tests."""
	return Verifier(mock, scale=LetterScale(G=G), K=2)


def _fallback_mock(text: str, logprobs_value: object) -> MockLLM:
	"""MockLLM that always returns the given (text, logprobs_value) from chat_with_logprobs."""
	mock = MockLLM(default_text="MOCK")
	response = MockResponse(text, logprobs=logprobs_value)

	def _handler(messages, **kw):  # noqa: ARG001
		return response

	mock.add_rule(lambda _msgs, **_kw: True, _handler)
	return mock


# ══════════════════════════════════════════════════════════════════════════════
# _extract_scores_from_text  (direct unit tests via the private method)
# ══════════════════════════════════════════════════════════════════════════════


class TestExtractScoresFromText:
	"""Direct tests for the regex-based text-fallback parser."""

	def setup_method(self) -> None:
		scale = LetterScale(G=5)  # tokens A-E, phi=1..5
		self.v = Verifier(MockLLM(default_text="MOCK"), scale=scale)

	def test_normal_both_scores(self) -> None:
		raw_a, raw_b = self.v._extract_scores_from_text(_mk_text("C", "D"))
		# C → index 2 → phi=3; D → index 3 → phi=4
		assert raw_a == pytest.approx(3.0)
		assert raw_b == pytest.approx(4.0)

	def test_boundary_min(self) -> None:
		raw_a, raw_b = self.v._extract_scores_from_text(_mk_text("A", "B"))
		assert raw_a == pytest.approx(1.0)
		assert raw_b == pytest.approx(2.0)

	def test_boundary_max(self) -> None:
		# G=5 → E is max (index 4 → phi=5)
		raw_a, raw_b = self.v._extract_scores_from_text(_mk_text("D", "E"))
		assert raw_a == pytest.approx(4.0)
		assert raw_b == pytest.approx(5.0)

	def test_missing_score_a_raises(self) -> None:
		text = "<score_B> C </score_B>"
		with pytest.raises(ScoreExtractionError, match="logprobs 不可用且文本中未找到"):
			self.v._extract_scores_from_text(text)

	def test_missing_score_b_raises(self) -> None:
		text = "<score_A> C </score_A>"
		with pytest.raises(ScoreExtractionError, match="logprobs 不可用且文本中未找到"):
			self.v._extract_scores_from_text(text)

	def test_malformed_close_tags_raises(self) -> None:
		# Missing forward-slash in closing tag
		text = "<score_A> C <score_A> <score_B> D <score_B>"
		with pytest.raises(ScoreExtractionError):
			self.v._extract_scores_from_text(text)

	def test_empty_text_raises(self) -> None:
		with pytest.raises(ScoreExtractionError):
			self.v._extract_scores_from_text("")

	def test_no_tags_at_all_raises(self) -> None:
		with pytest.raises(ScoreExtractionError):
			self.v._extract_scores_from_text("Some random text without score tags")

	def test_only_score_a_raises(self) -> None:
		with pytest.raises(ScoreExtractionError):
			self.v._extract_scores_from_text("<score_A> C </score_A>")

	def test_letter_beyond_scale_raises_valueerror(self) -> None:
		"""G=5 (A-E); 'F' is outside the scale → tokens.index('F') raises ValueError.

		Note: this is a known edge case — the implementation could raise a more
		descriptive ScoreExtractionError instead of a raw ValueError when the LLM
		returns an out-of-scale letter.  The current behaviour is documented here.
		"""
		with pytest.raises(ValueError):
			self.v._extract_scores_from_text(_mk_text("F", "A"))

	def test_whitespace_around_letter_is_stripped(self) -> None:
		"""Extra spaces inside tags are tolerated."""
		raw_a, raw_b = self.v._extract_scores_from_text("<score_A>  C  </score_A>\n<score_B>  A  </score_B>")
		assert raw_a == pytest.approx(3.0)
		assert raw_b == pytest.approx(1.0)


# ══════════════════════════════════════════════════════════════════════════════
# score_pair fallback paths  (integrated through _score_once → score_pair)
# ══════════════════════════════════════════════════════════════════════════════


class TestScorePairFallback:
	"""Verify that _score_once picks the correct path based on logprobs shape."""

	def test_empty_list_logprobs_triggers_text_fallback(self) -> None:
		"""logprobs = [] (falsy) → use_text_fallback → _extract_scores_from_text."""
		mock = _fallback_mock(_mk_text("C", "A"), [])
		v = _verifier(mock)
		result = v.score_pair("task", "traj_a", "traj_b")
		# C→phi=3→norm=(3-1)/4=0.5; A→phi=1→norm=0
		assert result.ra == pytest.approx(0.5, abs=0.02)
		assert result.rb == pytest.approx(0.0, abs=0.02)
		assert result.calls == 6  # C=3 × K=2

	def test_dict_empty_content_triggers_text_fallback(self) -> None:
		"""logprobs = {"content": []} (content falsy) → text fallback."""
		mock = _fallback_mock(_mk_text("E", "C"), {"content": []})
		v = _verifier(mock)
		result = v.score_pair("task", "traj_a", "traj_b")
		# E→phi=5→norm=1.0; C→phi=3→norm=0.5
		assert result.ra == pytest.approx(1.0, abs=0.02)
		assert result.rb == pytest.approx(0.5, abs=0.02)

	def test_dict_none_content_triggers_text_fallback(self) -> None:
		"""logprobs = {"content": None} → None is falsy → text fallback."""
		mock = _fallback_mock(_mk_text("B", "D"), {"content": None})
		v = _verifier(mock)
		result = v.score_pair("task", "traj_a", "traj_b")
		# B→phi=2→norm=0.25; D→phi=4→norm=0.75
		assert result.ra == pytest.approx(0.25, abs=0.02)
		assert result.rb == pytest.approx(0.75, abs=0.02)

	def test_proper_logprobs_list_uses_expected_path(self) -> None:
		"""Non-empty per-token logprobs list → expected_from_top_logprobs (no fallback)."""
		G = 5
		dist_a = letter_distribution(3, G)  # centre = D
		dist_b = letter_distribution(1, G)  # centre = B
		mock = MockLLM(default_text="MOCK")
		response = score_response(dist_a, dist_b)

		def _handler(messages, **kw):  # noqa: ARG001
			return response

		mock.add_rule(lambda _msgs, **_kw: True, _handler)
		v = _verifier(mock)
		result = v.score_pair("task", "traj_a", "traj_b")
		# The expected-value path renormalises the distribution:
		# centre=D(phi=4) gives ra ~ 0.75; centre=B(phi=2) gives rb ~ 0.25
		assert result.ra == pytest.approx(0.75, abs=0.20)
		assert result.rb == pytest.approx(0.25, abs=0.20)

	def test_fallback_raises_when_text_has_no_tags(self) -> None:
		"""Empty logprobs AND text missing score tags → ScoreExtractionError."""
		mock = _fallback_mock("No score tags here.", [])
		v = _verifier(mock)
		with pytest.raises(ScoreExtractionError):
			v.score_pair("task", "traj_a", "traj_b")

	def test_unusable_logprobs_distribution_falls_back_to_text(self) -> None:
		"""Logprobs present but answer position has no letter tokens (e.g. DeepSeek
		splits <score_A> into < / score / _A and the top_logprobs at the answer
		position contain digits only) → fall back to text parsing instead of
		raising ScoreExtractionError."""
		entries = [
			{"token": "<score_A>", "logprob": -0.01, "top_logprobs": [{"token": "<score_A>", "logprob": -0.01}]},
			{"token": " 18", "logprob": -0.01,
			 "top_logprobs": [{"token": " 18", "logprob": -0.01}, {"token": " 19", "logprob": -2.0}]},
			{"token": "</score_A>", "logprob": -0.01, "top_logprobs": [{"token": "</score_A>", "logprob": -0.01}]},
		]
		mock = _fallback_mock(_mk_text("C", "A"), entries)
		v = _verifier(mock)
		result = v.score_pair("task", "traj_a", "traj_b")
		# Text fallback: C→phi=3→norm=0.5; A→phi=1→norm=0
		assert result.ra == pytest.approx(0.5, abs=0.02)
		assert result.rb == pytest.approx(0.0, abs=0.02)

	def test_unusable_logprobs_and_no_text_tags_raises(self) -> None:
		"""Logprobs unusable AND text has no score tags → ScoreExtractionError (no silent default)."""
		entries = [
			{"token": "<score_A>", "logprob": -0.01, "top_logprobs": [{"token": "<score_A>", "logprob": -0.01}]},
			{"token": " 18", "logprob": -0.01,
			 "top_logprobs": [{"token": " 18", "logprob": -0.01}]},
		]
		mock = _fallback_mock("No score tags here.", entries)
		v = _verifier(mock)
		with pytest.raises(ScoreExtractionError):
			v.score_pair("task", "traj_a", "traj_b")


# ══════════════════════════════════════════════════════════════════════════════
# extract_tag_distribution  dict/list dual-input compatibility
# ══════════════════════════════════════════════════════════════════════════════


class TestExtractTagDistribution:
	"""Tests for dict/list dual-input support in extract_tag_distribution."""

	def test_list_input(self) -> None:
		"""Per-token list (native OpenAI logprobs format)."""
		entries: list[dict] = [
			{"token": "<score_A>", "logprob": -0.1, "top_logprobs": []},
			{"token": " ", "logprob": -0.1, "top_logprobs": []},  # whitespace: skipped
			{
				"token": "C",
				"logprob": -0.5,
				"top_logprobs": [
					{"token": "C", "logprob": math.log(0.7)},
					{"token": "B", "logprob": math.log(0.2)},
					{"token": "D", "logprob": math.log(0.1)},
				],
			},
		]
		result = extract_tag_distribution(entries, "score_A")
		# Finds <score_A>, skips whitespace, returns C's top_logprobs
		assert len(result) == 3
		assert {e["token"] for e in result} == {"C", "B", "D"}

	def test_dict_input(self) -> None:
		"""Wrapped dict format (skill_evolution client return shape)."""
		entries: list[dict] = [
			{"token": "<score_B>", "logprob": -0.1, "top_logprobs": []},
			{"token": " ", "logprob": -0.1, "top_logprobs": []},
			{"token": "A", "logprob": -0.5, "top_logprobs": [
				{"token": "A", "logprob": math.log(0.8)},
				{"token": "B", "logprob": math.log(0.2)},
			]},
		]
		wrapped = {"content": entries, "prompt_logprobs": {}}
		result = extract_tag_distribution(wrapped, "score_B")
		assert len(result) == 2
		assert {e["token"] for e in result} == {"A", "B"}

	def test_missing_tag_raises(self) -> None:
		entries = [
			{"token": "no", "logprob": -0.1, "top_logprobs": []},
			{"token": "score", "logprob": -0.1, "top_logprobs": []},
		]
		with pytest.raises(ScoreExtractionError, match="未找到"):
			extract_tag_distribution(entries, "score_A")

	def test_tag_last_with_no_following_token_raises(self) -> None:
		"""Tag is the last token → no following non-empty token → raises."""
		entries = [{"token": "<score_A>", "logprob": -0.1, "top_logprobs": []}]
		with pytest.raises(ScoreExtractionError, match="之后没有可用的评分 token"):
			extract_tag_distribution(entries, "score_A")

	def test_tag_followed_only_by_whitespace_raises(self) -> None:
		"""Only whitespace after the tag → no non-empty token to extract."""
		entries = [
			{"token": "<score_A>", "logprob": -0.1, "top_logprobs": []},
			{"token": " ", "logprob": -0.1, "top_logprobs": []},
			{"token": "\n", "logprob": -0.1, "top_logprobs": []},
		]
		with pytest.raises(ScoreExtractionError, match="之后没有可用的评分 token"):
			extract_tag_distribution(entries, "score_A")

	def test_empty_dict_content_raises(self) -> None:
		with pytest.raises(ScoreExtractionError, match="未找到"):
			extract_tag_distribution({"content": []}, "score_A")

	def test_dict_no_content_key(self) -> None:
		"""Dict without 'content' key → empty search → no tag found."""
		with pytest.raises(ScoreExtractionError, match="未找到"):
			extract_tag_distribution({"other": "data"}, "score_A")


# ══════════════════════════════════════════════════════════════════════════════
# expected_from_top_logprobs  edge cases
# ══════════════════════════════════════════════════════════════════════════════


class TestExpectedFromTopLogprobs:
	"""Edge cases for the logprob-expectation scorer."""

	def test_foreign_tokens_filtered(self) -> None:
		"""Non-scoring-token entries (e.g. 'the', 'score') are filtered, only
		scale letters are kept and renormalised."""
		scale = LetterScale(G=5)
		top = [
			{"token": "the", "logprob": math.log(0.4)},
			{"token": "B", "logprob": math.log(0.3)},
			{"token": "a", "logprob": math.log(0.2)},
			{"token": "score", "logprob": math.log(0.1)},
		]
		result = expected_from_top_logprobs(top, scale)
		# Only B (phi=2) survives → renormalised → 2.0
		assert result == pytest.approx(2.0)

	def test_multiple_scoring_tokens_renormalised(self) -> None:
		"""Two scoring tokens: their probs are renormalised to sum-to-1."""
		scale = LetterScale(G=5)
		top = [
			{"token": "C", "logprob": math.log(0.6)},  # phi=3
			{"token": "E", "logprob": math.log(0.4)},  # phi=5
		]
		result = expected_from_top_logprobs(top, scale)
		expected = 0.6 * 3 + 0.4 * 5  # = 1.8 + 2.0 = 3.8
		assert result == pytest.approx(expected)

	def test_no_scoring_tokens_raises(self) -> None:
		scale = LetterScale(G=5)
		top = [
			{"token": "x", "logprob": math.log(0.5)},
			{"token": "y", "logprob": math.log(0.5)},
		]
		with pytest.raises(ScoreExtractionError, match="没有任何评分 token"):
			expected_from_top_logprobs(top, scale)

	def test_duplicate_token_takes_max_prob(self) -> None:
		"""Same token appearing twice → keep the entry with the higher logprob."""
		scale = LetterScale(G=5)
		top = [
			{"token": "C", "logprob": math.log(0.3)},
			{"token": "C", "logprob": math.log(0.7)},
		]
		result = expected_from_top_logprobs(top, scale)
		# Only C (phi=3), p = 0.7 → 3.0
		assert result == pytest.approx(3.0)
