fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protos: Vec<String> = ["accounts", "categories", "imports", "links", "reports", "rules", "transactions"]
        .iter()
        .map(|name| format!("../../proto/finance/{name}.proto"))
        .collect();
    tonic_prost_build::configure().build_client(false).compile_protos(&protos, &["../../proto".to_owned()])?;
    println!("cargo:rerun-if-changed=../../proto");
    Ok(())
}
