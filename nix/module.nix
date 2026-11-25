# NixOS module for Tally. Import it from a checkout or a pinned fetch of this repo:
#   imports = [ "${tally}/nix/module.nix" ];
#   services.tally = {
#     enable = true;
#     passkey.enable = true;         # sign in with a passkey
#     tailscaleServe.enable = true;  # https://<machine>.<tailnet>.ts.net, needed for passkeys
#   };
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
        Address and port to serve on. Without {option}`services.tally.passkey.enable`, anyone who
        can reach this address sees all your transactions. Keep it on localhost and use
        {option}`services.tally.tailscaleServe` to reach it.
      '';
    };

    passkey.enable = lib.mkEnableOption ''
      passkey sign-in. Until a passkey is set up, Tally shows a setup screen, and the first passkey
      made there is the only one that opens it, so set it up right after deploying. It is saved in
      `/var/lib/tally/passkey.json`: delete that file to sign every device out and set up again.
      Passkeys need https, which {option}`services.tally.tailscaleServe` provides'';

    tailscaleServe = {
      enable = lib.mkEnableOption ''
        serving Tally to your tailnet at `https://<machine>.<tailnet>.ts.net` with `tailscale serve`,
        which also gets and renews the https certificate. Turn on HTTPS certificates in the tailnet's
        DNS settings first. Only devices on the tailnet can reach it'';

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "The https port on the tailnet.";
      };
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
    assertions = [
      {
        assertion = cfg.tailscaleServe.enable -> config.services.tailscale.enable;
        message = "services.tally.tailscaleServe needs services.tailscale.enable.";
      }
    ];

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
      }
      // lib.optionalAttrs cfg.passkey.enable { PASSKEY_FILE = "/var/lib/tally/passkey.json"; };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "tally";
        Group = "tally";
        Restart = "on-failure";
        RestartSec = 5;
        StateDirectory = "tally"; # the passkey file
        StateDirectoryMode = "0700";

        # Tally only needs the network, the Postgres socket and its state directory.
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

    # `tailscale serve` keeps its setting in tailscaled's state; this sets it on every boot and
    # removes it when the option is turned off.
    systemd.services.tally-tailscale-serve = lib.mkIf cfg.tailscaleServe.enable (
      let
        tailscale = lib.getExe config.services.tailscale.package;
        https = toString cfg.tailscaleServe.port;
      in
      {
        description = "Serve Tally on the tailnet";
        after = [
          "tailscaled.service"
          "tailscaled-autoconnect.service"
          "tally.service"
        ];
        wants = [ "tailscaled.service" ];
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${tailscale} serve --bg --yes --https=${https} http://${cfg.listenAddress}";
          ExecStop = "${tailscale} serve --yes --https=${https} off";
          # tailscaled may not be signed in yet right after boot, and serve waits for HTTPS
          # certificates to be turned on: retry, without holding up a rebuild for long.
          Restart = "on-failure";
          RestartSec = 10;
          TimeoutStartSec = "1min";
        };
      }
    );
  };
}
