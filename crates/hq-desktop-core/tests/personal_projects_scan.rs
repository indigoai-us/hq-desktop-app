use std::collections::HashSet;
use std::fs;

use hq_desktop_core::projects_local::{
    resolve_project_path, scan_local_projects, scan_local_projects_for_authorized_scopes,
    scan_local_projects_for_companies,
};

fn write_prd(root: &std::path::Path, relative: &str, name: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("PRD has a parent")).expect("create project folder");
    fs::write(path, format!(r#"{{"name":"{name}","userStories":[]}}"#))
        .expect("write synthetic PRD");
}

#[test]
fn personal_projects_are_listed() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(
        root.path(),
        "personal/projects/demo/prd.json",
        "Personal demo",
    );
    fs::write(
        root.path().join("personal/board.json"),
        r#"{"projects":[{"id":"personal-demo","title":"Personal demo from board","status":"active","prd_path":"personal/projects/demo/prd.json"}]}"#,
    )
    .expect("write synthetic Personal board");

    let projects = scan_local_projects(root.path());
    let project = projects
        .iter()
        .find(|project| project.prd_path.as_deref() == Some("personal/projects/demo/prd.json"));

    assert!(project.is_some(), "Personal project must be listed");
    let project = project.expect("Personal project listed");
    assert_eq!(project.title, "Personal demo from board");
    assert_eq!(project.company, "personal");
    assert_eq!(project.board_path.as_deref(), Some("personal/board.json"));
}

#[test]
fn root_projects_are_listed_in_the_personal_home_group() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(root.path(), "projects/root-demo/prd.json", "Root demo");

    let projects = scan_local_projects(root.path());
    let project = projects
        .iter()
        .find(|project| project.prd_path.as_deref() == Some("projects/root-demo/prd.json"));

    assert!(project.is_some(), "Root project must be listed");
    let project = project.expect("Root project listed");
    assert_eq!(project.company, "personal");
    assert_eq!(project.board_path.as_deref(), Some("board.json"));
}

#[cfg(unix)]
#[test]
fn root_projects_are_listed_when_the_hq_root_is_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("temporary canonical HQ root");
    write_prd(root.path(), "projects/root-demo/prd.json", "Root demo");
    let alias_parent = tempfile::tempdir().expect("temporary alias parent");
    let hq_alias = alias_parent.path().join("hq-link");
    symlink(root.path(), &hq_alias).expect("create synthetic HQ root symlink");

    let projects = scan_local_projects(&hq_alias);
    let project = projects
        .iter()
        .find(|project| project.prd_path.as_deref() == Some("projects/root-demo/prd.json"));

    assert!(
        project.is_some(),
        "Root project must survive an HQ root alias"
    );
    assert_eq!(project.expect("Root project listed").company, "personal");
}

#[test]
fn personal_path_resolves_without_a_company_slug() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(
        root.path(),
        "personal/projects/demo/prd.json",
        "Personal demo",
    );

    let project = scan_local_projects(root.path())
        .into_iter()
        .find(|project| project.prd_path.as_deref() == Some("personal/projects/demo/prd.json"))
        .expect("Personal project must be listed before its scope can be checked");
    let target = resolve_project_path(
        root.path(),
        project.prd_path.as_deref().expect("Personal PRD path"),
        "prd.json",
    )
    .expect("Personal project path resolves");

    assert_eq!(target.company_slug, None);
    assert_eq!(target.relative_path, "personal/projects/demo/prd.json");
}

#[cfg(unix)]
#[test]
fn symlinked_personal_project_is_skipped_while_canonical_project_is_listed() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(
        root.path(),
        "personal/projects/visible/prd.json",
        "Visible personal project",
    );
    write_prd(
        root.path(),
        "companies/indigo/projects/secret/prd.json",
        "Company secret",
    );
    symlink(
        root.path().join("companies/indigo/projects/secret"),
        root.path().join("personal/projects/linked-company-project"),
    )
    .expect("create synthetic project symlink");

    let projects = scan_local_projects(root.path());
    let paths = projects
        .iter()
        .filter_map(|project| project.prd_path.as_deref())
        .collect::<Vec<_>>();

    assert!(paths.contains(&"personal/projects/visible/prd.json"));
    assert!(!paths.contains(&"personal/projects/linked-company-project/prd.json"));
    assert!(paths.contains(&"companies/indigo/projects/secret/prd.json"));
}

#[test]
fn personal_slug_does_not_authorize_a_company_directory() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(
        root.path(),
        "companies/personal/projects/company-shaped/prd.json",
        "Must not be a company project",
    );
    let authorized_company_slugs = HashSet::from(["personal".to_string()]);

    let projects = scan_local_projects_for_companies(root.path(), &authorized_company_slugs);

    assert!(
        projects.is_empty(),
        "the reserved Personal workspace identifier must not authorize companies/personal"
    );
}

#[test]
fn unauthorized_personal_scope_excludes_personal_and_root_projects() {
    let root = tempfile::tempdir().expect("temporary HQ root");
    write_prd(
        root.path(),
        "personal/projects/personal-demo/prd.json",
        "Personal demo",
    );
    write_prd(root.path(), "projects/root-demo/prd.json", "Root demo");
    write_prd(
        root.path(),
        "companies/indigo/projects/company-demo/prd.json",
        "Company demo",
    );
    let companies = HashSet::from(["indigo".to_string()]);

    let projects = scan_local_projects_for_authorized_scopes(root.path(), &companies, false);
    let paths = projects
        .iter()
        .filter_map(|project| project.prd_path.as_deref())
        .collect::<Vec<_>>();

    assert!(!paths.contains(&"personal/projects/personal-demo/prd.json"));
    assert!(!paths.contains(&"projects/root-demo/prd.json"));
    assert!(paths.contains(&"companies/indigo/projects/company-demo/prd.json"));
    let company = projects
        .iter()
        .find(|project| {
            project.prd_path.as_deref() == Some("companies/indigo/projects/company-demo/prd.json")
        })
        .expect("company project listed");
    assert_eq!(
        company.board_path.as_deref(),
        Some("companies/indigo/board.json")
    );
}
