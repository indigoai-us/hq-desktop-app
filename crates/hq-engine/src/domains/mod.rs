//! Stable command ownership boundaries for parallel native-engine extraction.

pub(crate) mod cloud;
pub mod local;
pub(crate) mod meetings;
pub(crate) mod node;
pub(crate) mod oauth;
pub(crate) mod orchestration;
pub(crate) mod recall;

use serde_json::Value;

use crate::{CancellationFlag, EngineBackend, EngineError};

pub(crate) fn is_implemented(method_name: &str) -> bool {
    local::IMPLEMENTED_METHODS.contains(&method_name)
        || cloud::IMPLEMENTED_METHODS.contains(&method_name)
        || node::IMPLEMENTED_METHODS.contains(&method_name)
        || meetings::IMPLEMENTED_METHODS.contains(&method_name)
        || oauth::IMPLEMENTED_METHODS.contains(&method_name)
        || recall::IMPLEMENTED_METHODS.contains(&method_name)
        || orchestration::IMPLEMENTED_METHODS.contains(&method_name)
}

impl EngineBackend for local::CoreBackend {
    fn execute(
        &self,
        method_name: &str,
        params: &Value,
        cancellation: &CancellationFlag,
    ) -> Result<Value, EngineError> {
        if local::IMPLEMENTED_METHODS.contains(&method_name) {
            self.execute_local(method_name, params, cancellation)
        } else if cloud::IMPLEMENTED_METHODS.contains(&method_name) {
            cloud::execute(self, method_name, params, cancellation)
        } else if node::IMPLEMENTED_METHODS.contains(&method_name) {
            node::execute(self, method_name, params, cancellation)
        } else if meetings::IMPLEMENTED_METHODS.contains(&method_name) {
            meetings::execute(self, method_name, params, cancellation)
        } else if oauth::IMPLEMENTED_METHODS.contains(&method_name) {
            oauth::execute(self, method_name, params, cancellation)
        } else if recall::IMPLEMENTED_METHODS.contains(&method_name) {
            recall::execute(self, method_name, params, cancellation)
        } else if orchestration::IMPLEMENTED_METHODS.contains(&method_name) {
            orchestration::execute(self, method_name, params, cancellation)
        } else {
            Err(EngineError::new(
                "method_not_found",
                format!("Method `{method_name}` is not implemented"),
                false,
            ))
        }
    }

    fn shutdown(&self) {
        self.shutdown_external_sync_progress_watcher();
        self.shutdown_managed_processes();
        recall::shutdown_global();
    }
}
