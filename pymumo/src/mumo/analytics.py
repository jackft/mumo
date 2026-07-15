"""Convenience functions for conversational timing analysis."""
from __future__ import annotations
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .doc import MumoDoc
    from .views import Utterance


@dataclass
class Gap:
    """
    Inter-turn interval between two temporally consecutive utterances.

    duration > 0: silence between turns
    duration < 0: next turn starts while previous is still ongoing (overlap)
    duration == 0: back-to-back with no gap
    """
    before: object   # Utterance
    after:  object   # Utterance
    duration: float  # seconds

    @property
    def is_overlap(self) -> bool:
        return self.duration < 0

    @property
    def is_silence(self) -> bool:
        return self.duration > 0

    def __repr__(self) -> str:
        label = 'overlap' if self.is_overlap else 'gap'
        return (f'Gap({self.before.participant!r}→{self.after.participant!r}, '
                f'{self.duration:+.3f}s [{label}])')


def gaps(doc: MumoDoc, *,
         min_duration: float | None = None,
         max_duration: float | None = None) -> list[Gap]:
    """
    All inter-turn intervals between temporally adjacent timed utterances,
    sorted by the start time of the later utterance.

    Filters:
      min_duration  — skip intervals shorter than this (seconds)
      max_duration  — skip intervals longer than this (seconds)

    Typical use:
      gaps(doc)                           # everything
      gaps(doc, min_duration=0)           # only silences (no overlaps)
      gaps(doc, max_duration=0)           # only overlaps
      gaps(doc, min_duration=0.2)         # notable pauses only
    """
    timed = sorted(
        [u for u in doc.utterances
         if u.start_time is not None and u.end_time is not None],
        key=lambda u: u.start_time,
    )
    result = []
    for i in range(len(timed) - 1):
        a, b = timed[i], timed[i + 1]
        dur = b.start_time - a.end_time
        if min_duration is not None and dur < min_duration:
            continue
        if max_duration is not None and dur > max_duration:
            continue
        result.append(Gap(before=a, after=b, duration=dur))
    return result


def pauses(doc: MumoDoc, min_duration: float = 0.2) -> list[Gap]:
    """
    Inter-turn silences of at least *min_duration* seconds (default 0.2 s).
    Overlaps are excluded.
    """
    return gaps(doc, min_duration=min_duration)


def overlaps_by_timing(doc: MumoDoc) -> list[Gap]:
    """
    Inter-turn intervals where the next turn starts before the previous ends.
    Complements doc.overlap_groups (which uses bracket marks, not raw timing).
    """
    return gaps(doc, max_duration=0)
