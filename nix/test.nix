# NixOS VM test: the module starts Tally on a local Postgres, creates its tables and serves the app.
#   nix-build nix/test.nix
{
  pkgs ? import <nixpkgs> { },
}:

pkgs.testers.runNixOSTest {
  name = "tally";

  nodes.machine = {
    imports = [ ./module.nix ];
    services.tally.enable = true;
  };

  testScript = ''
    machine.wait_for_unit("tally.service")
    machine.wait_for_open_port(8080)
    machine.succeed("curl -fs http://127.0.0.1:8080/ | grep -q '<title>Tally</title>'")
    machine.succeed("test $(sudo -u postgres psql -d tally -tAc 'select count(*) from seaql_migrations') -gt 0")

    # Restarting runs the migrations again, which must be a no-op.
    machine.systemctl("restart tally.service")
    machine.wait_for_unit("tally.service")
    machine.wait_for_open_port(8080)
    machine.succeed("curl -fs http://127.0.0.1:8080/ >/dev/null")
  '';
}
