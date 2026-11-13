//! Render engine: `.creatora` timeline → ffmpeg filter graph (ADR-015).
//! Export runs through the job engine; preview mirrors the same segment
//! math on the TS side (`src/lib/timeline-engine.ts`).

pub mod commands;
pub mod effects;
pub mod keyframes;
pub mod plan;
pub mod text;
