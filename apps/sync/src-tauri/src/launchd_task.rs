fn launchd_task_command(args: &[String]) -> Option<(&str, &[String])> {
    if args.get(1).map(String::as_str) != Some("--hq-launchd-task") {
        return None;
    }
    let program = args.get(2)?;
    let is_node = std::path::Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "node" || name == "node.exe");
    let forwarded = args.get(3..)?;
    (is_node && !forwarded.is_empty()).then(|| (program.as_str(), forwarded))
}

pub fn run_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if let Some((program, child_args)) = launchd_task_command(&args) {
        let status = std::process::Command::new(program)
            .args(child_args)
            .status()
            .unwrap_or_else(|error| {
                eprintln!("HQ LaunchAgent could not start its task: {error}");
                std::process::exit(127);
            });
        std::process::exit(status.code().unwrap_or(1));
    }
}

#[cfg(test)]
mod tests {
    use super::launchd_task_command;

    #[test]
    fn recognizes_launcher_protocol_and_forwards_arguments() {
        let args = vec![
            "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar".into(),
            "--hq-launchd-task".into(),
            "/usr/bin/node".into(),
            "/opt/hq/dist/index.js".into(),
            "daemon".into(),
            "run".into(),
        ];
        let (program, forwarded) = launchd_task_command(&args).expect("task invocation");
        assert_eq!(program, "/usr/bin/node");
        assert_eq!(
            forwarded,
            ["/opt/hq/dist/index.js", "daemon", "run"]
        );
    }

    #[test]
    fn ignores_normal_app_launches_and_incomplete_invocations() {
        assert!(launchd_task_command(&["hq-sync-menubar".into()]).is_none());
        assert!(launchd_task_command(&["hq".into(), "--hq-launchd-task".into()]).is_none());
        assert!(launchd_task_command(&[
            "hq".into(),
            "--hq-launchd-task".into(),
            "/bin/sh".into(),
            "-c".into()
        ])
        .is_none());
        assert!(launchd_task_command(&["hq".into(), "--hq-launchd-task".into(), "/usr/bin/node".into()]).is_none());
    }
}
