# Tally: the `tally` server with the built web app. Build it with your own nixpkgs:
#   pkgs.callPackage ./nix/package.nix { }
{
  lib,
  rustPlatform,
  buildNpmPackage,
  protobuf,
  makeWrapper,
}:

let
  version = (lib.importTOML ../Cargo.toml).workspace.package.version;
  fs = lib.fileset;
  # Only the files a build reads, so docs or demo changes don't trigger a rebuild. Local build
  # output is left out, which matters when building from a checkout.
  local = paths: fs.unions (map fs.maybeMissing paths);

  web = buildNpmPackage {
    pname = "tally-web";
    inherit version;
    src = fs.toSource {
      root = ../web;
      fileset = fs.difference ../web (local [
        ../web/node_modules
        ../web/dist
        ../web/demo
        ../web/tsconfig.tsbuildinfo
      ]);
    };
    # Update when web/package-lock.json changes: run `prefetch-npm-deps web/package-lock.json`,
    # or build once and copy the hash from the error.
    npmDepsHash = "sha256-r/Dpw7iBZ1QglFbEezyruNQFNjDPmkrVQr0gJxFAQcs=";
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
rustPlatform.buildRustPackage {
  pname = "tally";
  inherit version;

  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
      ../proto
    ];
  };
  cargoLock.lockFile = ../Cargo.lock;

  cargoBuildFlags = [
    "-p"
    "tally-server"
  ];
  # The parser tests need nothing else. The ledger tests need Postgres; run them with `test-all`.
  cargoTestFlags = [
    "-p"
    "sources"
  ];

  nativeBuildInputs = [
    protobuf # the server's build.rs compiles proto/finance
    makeWrapper
  ];

  postInstall = ''
    wrapProgram $out/bin/tally --set-default WEB_DIR ${web}
  '';

  passthru = { inherit web; };

  meta = {
    description = "Personal finance tracker for bank and credit-card exports";
    homepage = "https://github.com/kalmjasper/tally";
    license = lib.licenses.asl20;
    mainProgram = "tally";
    platforms = lib.platforms.unix;
  };
}
