use hq_engine::{blocked_parity_command_names, ParityDependency};

fn main() {
    let requested = std::env::args().nth(1);
    let dependencies = [
        ParityDependency::LocalOrchestration,
        ParityDependency::CloudRuntime,
        ParityDependency::NodeRuntime,
        ParityDependency::RecallRuntime,
        ParityDependency::GStreamerRuntime,
        ParityDependency::NativeRuntime,
    ];
    let selected = match requested.as_deref() {
        Some(filter) => match dependencies
            .iter()
            .copied()
            .find(|dependency| dependency.as_str() == filter)
        {
            Some(dependency) => vec![dependency],
            None => {
                eprintln!("unknown parity dependency `{filter}`");
                std::process::exit(2);
            }
        },
        None => dependencies.to_vec(),
    };

    let mut blocked = 0;
    for dependency in selected {
        let commands = blocked_parity_command_names(Some(dependency));
        println!("{} ({})", dependency.as_str(), commands.len());
        blocked += commands.len();
        for command in &commands {
            println!("{command}");
        }
    }
    if blocked > 0 {
        std::process::exit(1);
    }
}
