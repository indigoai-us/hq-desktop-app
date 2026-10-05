use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UpdateOutcomeStage {
    CheckStarted,
    UpdateAvailable,
    UpToDate,
    DownloadOk,
    DownloadFailed,
    InstallStarted,
    InstallFailed,
    InstallDeferredUserOff,
}

impl UpdateOutcomeStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckStarted => "check_started",
            Self::UpdateAvailable => "update_available",
            Self::UpToDate => "up_to_date",
            Self::DownloadOk => "download_ok",
            Self::DownloadFailed => "download_failed",
            Self::InstallStarted => "install_started",
            Self::InstallFailed => "install_failed",
            Self::InstallDeferredUserOff => "install_deferred_user_off",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateOutcomeProperties {
    pub stage: &'static str,
    pub from_version: String,
    pub to_version: String,
    pub channel: String,
    pub auto_update: bool,
}

/// Per-check telemetry context. Clones share the stage set so installation in
/// a later command cannot repeat a stage from the same update attempt.
#[derive(Clone)]
pub struct UpdateOutcomeAttempt {
    from_version: String,
    channel: String,
    auto_update: bool,
    emitted: Arc<Mutex<HashSet<UpdateOutcomeStage>>>,
}

impl UpdateOutcomeAttempt {
    pub fn new(from_version: String, channel: &str, auto_update: bool) -> Self {
        Self {
            from_version,
            channel: channel.to_string(),
            auto_update,
            emitted: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Return the updater result unchanged even if the best-effort telemetry
    /// sender reports an error. A stage is sent no more than once per attempt.
    pub fn observe_result<T, E>(
        &self,
        stage: UpdateOutcomeStage,
        to_version: &str,
        result: Result<T, E>,
        send: impl FnOnce(UpdateOutcomeProperties) -> Result<(), String>,
    ) -> Result<T, E> {
        let should_emit = self
            .emitted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(stage);
        if should_emit {
            let properties = UpdateOutcomeProperties {
                stage: stage.as_str(),
                from_version: self.from_version.clone(),
                to_version: to_version.to_string(),
                channel: self.channel.clone(),
                auto_update: self.auto_update,
            };
            let _ = send(properties);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stage_emits_bounded_join_properties_once_per_attempt() {
        let stages = [
            (UpdateOutcomeStage::CheckStarted, "check_started"),
            (UpdateOutcomeStage::UpdateAvailable, "update_available"),
            (UpdateOutcomeStage::UpToDate, "up_to_date"),
            (UpdateOutcomeStage::DownloadOk, "download_ok"),
            (UpdateOutcomeStage::DownloadFailed, "download_failed"),
            (UpdateOutcomeStage::InstallStarted, "install_started"),
            (UpdateOutcomeStage::InstallFailed, "install_failed"),
            (
                UpdateOutcomeStage::InstallDeferredUserOff,
                "install_deferred_user_off",
            ),
        ];
        for (stage, expected) in stages {
            let attempt = UpdateOutcomeAttempt::new("0.10.386".into(), "stable", false);
            let sibling = attempt.clone();
            let mut sent = Vec::new();
            assert_eq!(
                attempt.observe_result(stage, "0.10.387", Ok::<_, ()>(()), |properties| {
                    sent.push(properties);
                    Ok(())
                }),
                Ok(())
            );
            assert_eq!(
                sibling.observe_result(stage, "0.10.387", Ok::<_, ()>(()), |_| {
                    panic!("a stage may only be sent once for one attempt")
                }),
                Ok(())
            );
            assert_eq!(
                sent,
                vec![UpdateOutcomeProperties {
                    stage: expected,
                    from_version: "0.10.386".into(),
                    to_version: "0.10.387".into(),
                    channel: "stable".into(),
                    auto_update: false,
                }]
            );
        }
    }

    #[test]
    fn a_telemetry_send_failure_preserves_the_updater_result() {
        let attempt = UpdateOutcomeAttempt::new("0.10.386".into(), "beta", true);
        let result = attempt.observe_result(
            UpdateOutcomeStage::DownloadFailed,
            "0.10.387",
            Err::<(), _>("download failed"),
            |_| Err("telemetry unavailable".into()),
        );
        assert_eq!(result, Err("download failed"));
    }

    #[test]
    fn user_opt_out_is_an_explicit_false_value() {
        let attempt = UpdateOutcomeAttempt::new("0.10.386".into(), "alpha", false);
        let mut captured = None;
        let _ = attempt.observe_result(
            UpdateOutcomeStage::InstallDeferredUserOff,
            "0.10.386",
            Ok::<_, ()>(()),
            |properties| {
                captured = Some(properties);
                Ok(())
            },
        );
        assert_eq!(captured.unwrap().auto_update, false);
    }
}
