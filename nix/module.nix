# NixOS module for Tally. Import it from a checkout or a pinned fetch of this repo:
#   imports = [ "${tally}/nix/module.nix" ];
#   services.tally.enable = true;
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.tally;
in
{
  options.services.tally = {
    enable = lib.mkEnableOption "Tally, a personal finance tracker";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The Tally package to run.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:8080";
      example = "100.64.0.1:8080";
      description = ''
        Address and port to serve on. Tally has no login, so anyone who can reach this address
        sees all your transactions: keep it on localhost (and put something like `tailscale serve`
        in front), or on an address only you can reach.
      '';
    };

    database = {
      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Create a local PostgreSQL database and role named `tally`. The service connects over
          the Unix socket as the `tally` system user, so there is no password.
        '';
      };

      url = lib.mkOption {
        type = lib.types.str;
        default = "postgres://tally@localhost/tally?host=/run/postgresql";
        description = ''
          PostgreSQL connection URL. The default fits `createLocally`. Tally creates and updates
          its own tables on start.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ "tally" ];
      ensureUsers = [
        {
          name = "tally";
          ensureDBOwnership = true;
        }
      ];
    };

    users.users.tally = {
      isSystemUser = true;
      group = "tally";
    };
    users.groups.tally = { };

    systemd.services.tally = {
      description = "Tally personal finance tracker";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ lib.optional cfg.database.createLocally "postgresql.target";
      requires = lib.optional cfg.database.createLocally "postgresql.target";

      environment = {
        DATABASE_URL = cfg.database.url;
        LISTEN_ADDR = cfg.listenAddress;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "tally";
        Group = "tally";
        Restart = "on-failure";
        RestartSec = 5;

        # Tally only needs the network and the Postgres socket.
        CapabilityBoundingSet = "";
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        PrivateUsers = true;
        ProcSubset = "pid";
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
      };
    };
  };
}
