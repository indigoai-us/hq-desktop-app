fn main() {
    let summary = hq_engine::parity_summary();
    println!(
        "{}",
        serde_json::to_string_pretty(&summary)
            .expect("the parity summary has a fixed serializable schema")
    );
}
