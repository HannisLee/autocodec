use crate::models::{EncodeRule, EncoderChoice, ResolutionThreshold};

pub fn default_rules() -> Vec<EncodeRule> {
    vec![
        EncodeRule {
            id: "rule-1080p".into(),
            resolution: ResolutionThreshold::P1080,
            bitrate_threshold_kbps: 3500,
            target_codec: "hevc".into(),
            target_bitrate_kbps: 3400,
            preferred_encoder: EncoderChoice::Auto,
            maxrate_multiplier: 1.5,
            bufsize_multiplier: 2.0,
        },
        EncodeRule {
            id: "rule-2160p".into(),
            resolution: ResolutionThreshold::P2160,
            bitrate_threshold_kbps: 8800,
            target_codec: "hevc".into(),
            target_bitrate_kbps: 8500,
            preferred_encoder: EncoderChoice::Auto,
            maxrate_multiplier: 1.5,
            bufsize_multiplier: 2.0,
        },
    ]
}
