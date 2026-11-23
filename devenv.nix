{ pkgs, lib, config, inputs, ... }:

let
  # The mbx build cache. Invoked as `cargo`, mbx runs the command through its
  # cache and calls the real cargo further down PATH, which keeps target/ small.
  mbx = inputs.mr-boxington.packages.${pkgs.stdenv.hostPlatform.system}.mbx;
  mbxCargo = pkgs.runCommand "mbx-cargo-shim" { } ''
    mkdir -p $out/bin
    ln -s ${mbx}/bin/mbx $out/bin/cargo
  '';
in
{
  packages = [
    mbx
    pkgs.buf
    pkgs.protobuf
    pkgs.sea-orm-cli
    pkgs.postgresql_17 # initdb/pg_ctl/psql for scripts/with-ephemeral-postgres.sh
    pkgs.nodejs # web/ (Vite, buf generate with protoc-gen-es)
  ];

  languages.rust.enable = true;

  # Local Postgres for `cargo run -p tally-server`. Start it with `devenv up`.
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    listen_addresses = "127.0.0.1";
    port = 5432;
    initialDatabases = [{ name = "finance"; }];
  };

  env = {
    DATABASE_URL = "postgres://127.0.0.1:5432/finance";
    # A configured rustc wrapper (e.g. sccache) makes mbx stand aside and cache nothing.
    CARGO_BUILD_RUSTC_WRAPPER = "";
    # mbx caches no native link whose .dwo files it would not store.
    CARGO_PROFILE_DEV_SPLIT_DEBUGINFO = "off";
  };

  enterShell = ''
    unset RUSTC_WRAPPER
    export PATH=${mbxCargo}/bin:$PATH
  '';

  scripts.generate-entities.exec = ''
    exec "$DEVENV_ROOT/scripts/generate-entities.sh" "$@"
  '';
  scripts.test-all.exec = ''
    exec "$DEVENV_ROOT/scripts/with-ephemeral-postgres.sh" cargo test --workspace "$@"
  '';
  # Made-up data on a throwaway Postgres at http://127.0.0.1:18080, for screenshots.
  scripts.demo.exec = ''
    exec "$DEVENV_ROOT/scripts/demo.sh" "$@"
  '';
}
