use crate::models::{EncodeRule, EncoderChoice, ResolutionThreshold, VideoInfo};

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

pub fn match_rule(video: &VideoInfo, rules: &[EncodeRule]) -> Option<EncodeRule> {
    for rule in rules {
        if !rule.resolution.matches(video.width, video.height) {
            continue;
        }
        if video.bitrate_kbps <= rule.bitrate_threshold_kbps {
            continue;
        }
        let target_suffix = if rule.target_codec.eq_ignore_ascii_case("hevc") {
            &["hevc", "h265", "x265"]
        } else {
            &["h264", "avc", "x264"]
        };
        let current_is_target = target_suffix.iter().any(|s| {
            video.codec.to_lowercase().contains(s)
        });
        if current_is_target {
            continue;
        }
        return Some(rule.clone());
    }
    None
}
