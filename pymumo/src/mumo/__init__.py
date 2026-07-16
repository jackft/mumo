"""pymumo - Python library for reading and analysing MMEAF (mumo) files."""
from .doc import MumoDoc
from .views import (
    Utterance, Token, Textlet, EafAnnotation,
    Pattern, PatternSchema, SlotSchema, MetricSchema,
    Slot, MetricValue,
    UtteranceAnchor, TextletAnchor, TimeAnchor,
    OverlapMark, OverlapGroup,
    # backward-compat aliases
    PatternView, FrameView, UtteranceView, TokenView, TextletView,
    SlotView, SpanAnchor,
)
from .sqlite import export_to_sqlite
from .dataframes import patterns_df, frames_df, annotations_df
from .analytics import Gap, gaps, pauses, overlaps_by_timing

__all__ = [
    'MumoDoc',
    # core types
    'Utterance', 'Token', 'Textlet', 'EafAnnotation',
    'Pattern', 'PatternSchema', 'SlotSchema', 'MetricSchema',
    'Slot', 'MetricValue',
    'UtteranceAnchor', 'TextletAnchor', 'TimeAnchor',
    'OverlapMark', 'OverlapGroup',
    # backward-compat
    'PatternView', 'FrameView', 'UtteranceView', 'TokenView',
    'TextletView', 'SlotView', 'SpanAnchor',
    # utilities
    'export_to_sqlite',
    'patterns_df', 'frames_df', 'annotations_df',
    # analytics
    'Gap', 'gaps', 'pauses', 'overlaps_by_timing',
]
