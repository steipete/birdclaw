{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.birdclaw;
  configJson = builtins.toJSON cfg.config;
  generatedConfigPath = pkgs.writeText "birdclaw.config.json" "${configJson}\n";

  mkCmd =
    args:
    "${lib.getExe' cfg.package "birdclaw"} ${lib.concatMapStringsSep " " lib.escapeShellArg args}";

  mkAccountSyncCommand =
    {
      account,
      steps,
      mode,
      limit,
      maxPages,
      cacheTtlSeconds,
      refresh,
      logPath,
      ...
    }:
    mkCmd (
      [
        "--json"
        "jobs"
        "sync-account"
        "--steps"
        (lib.concatStringsSep "," steps)
        "--mode"
        mode
        "--limit"
        (toString limit)
        "--max-pages"
        (toString maxPages)
        "--cache-ttl"
        (toString cacheTtlSeconds)
      ]
      ++ lib.optionals (account != null) [
        "--account"
        account
      ]
      ++ lib.optionals (logPath != null) [
        "--log"
        logPath
      ]
      ++ lib.optionals refresh [ "--refresh" ]
    );

  mkBookmarkSyncCommand =
    {
      account ? null,
      mode,
      limit,
      maxPages,
      all,
      cacheTtlSeconds,
      refresh,
      logPath,
      ...
    }:
    mkCmd (
      [
        "--json"
        "jobs"
        "sync-bookmarks"
        "--mode"
        mode
        "--limit"
        (toString limit)
        "--cache-ttl"
        (toString cacheTtlSeconds)
      ]
      ++ lib.optionals (all) [ "--all" ]
      ++ lib.optionals (!all) [
        "--max-pages"
        (toString maxPages)
      ]
      ++ lib.optionals (account != null) [
        "--account"
        account
      ]
      ++ lib.optionals (logPath != null) [
        "--log"
        logPath
      ]
      ++ lib.optionals refresh [ "--refresh" ]
    );

  mkDigestCommand =
    {
      account ? null,
      windowHours,
      period ? null,
      includeDms ? false,
      model ? null,
      language ? null,
      maxTweets ? null,
      maxLinks ? null,
      logPath ? null,
      ...
    }:
    mkCmd (
      [
        "--json"
        "jobs"
        "run-digest"
        "--window-hours"
        (toString windowHours)
      ]
      ++ lib.optionals (account != null) [
        "--account"
        account
      ]
      ++ lib.optionals (period != null) [
        "--period"
        period
      ]
      ++ lib.optionals includeDms [ "--include-dms" ]
      ++ lib.optionals (model != null) [
        "--model"
        model
      ]
      ++ lib.optionals (language != null) [
        "--language"
        language
      ]
      ++ lib.optionals (maxTweets != null) [
        "--max-tweets"
        (toString maxTweets)
      ]
      ++ lib.optionals (maxLinks != null) [
        "--max-links"
        (toString maxLinks)
      ]
      ++ lib.optionals (logPath != null) [
        "--log"
        logPath
      ]
    );
in
{
  options.services.birdclaw = {
    enable = lib.mkEnableOption "Birdclaw local Twitter memory service";

    package = lib.mkPackageOption pkgs "birdclaw" { };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "%h/.birdclaw";
      description = "Directory used for Birdclaw data. %h resolves to the user's home directory at runtime.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Host interface Birdclaw binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3003;
      description = "Port Birdclaw listens on.";
    };

    allowRemoteWeb = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Set BIRDCLAW_ALLOW_REMOTE_WEB=1.";
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Environment files sourced by Birdclaw services.";
      example = [ "/etc/birdclaw/secrets.env" ];
    };

    config = lib.mkOption {
      type = lib.types.attrs;
      default = { };
      description = "Birdclaw configuration written to dataDir/config.json on first start.";
      example = {
        backup = {
          autoSync = true;
          staleAfterSeconds = 900;
        };
      };
    };

    jobs = {
      accountSync = {
        enable = lib.mkEnableOption "Periodic birdclaw jobs sync-account timer.";

        account = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Account id to sync in scheduled account jobs.";
        };

        intervalSeconds = lib.mkOption {
          type = lib.types.ints.positive;
          default = 30 * 60;
          description = "Refresh interval in seconds.";
        };

        steps = lib.mkOption {
          type = lib.types.listOf (
            lib.types.enum [
              "timeline"
              "mentions"
              "mention-threads"
              "likes"
              "bookmarks"
              "dms"
            ]
          );
          default = [
            "timeline"
            "mentions"
            "mention-threads"
            "likes"
            "bookmarks"
            "dms"
          ];
          description = "Sync steps passed to jobs sync-account.";
        };

        mode = lib.mkOption {
          type = lib.types.enum [
            "auto"
            "xurl"
            "bird"
          ];
          default = "auto";
          description = "Default transport mode for account sync job.";
        };

        limit = lib.mkOption {
          type = lib.types.ints.positive;
          default = 100;
          description = "Per-page/result limit.";
        };

        maxPages = lib.mkOption {
          type = lib.types.ints.positive;
          default = 3;
          description = "Maximum number of pages for account sync job.";
        };

        cacheTtlSeconds = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 120;
          description = "Live cache TTL in seconds for account sync job.";
        };

        refresh = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Pass --refresh to account job.";
        };

        logPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional --log path override.";
        };

        stdoutPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stdout redirection path for the systemd service.";
        };

        stderrPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stderr redirection path for the systemd service.";
        };
      };

      bookmarkSync = {
        enable = lib.mkEnableOption "Periodic birdclaw jobs sync-bookmarks timer.";

        intervalSeconds = lib.mkOption {
          type = lib.types.ints.positive;
          default = 3 * 60 * 60;
          description = "Refresh interval in seconds.";
        };

        mode = lib.mkOption {
          type = lib.types.enum [
            "auto"
            "xurl"
            "bird"
          ];
          default = "auto";
          description = "Default transport mode for bookmark sync job.";
        };

        limit = lib.mkOption {
          type = lib.types.ints.positive;
          default = 100;
          description = "Per-page/result limit.";
        };

        all = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Pass --all for bookmark sync job.";
        };

        maxPages = lib.mkOption {
          type = lib.types.ints.positive;
          default = 5;
          description = "Maximum number of pages when --all is false.";
        };

        cacheTtlSeconds = lib.mkOption {
          type = lib.types.ints.unsigned;
          default = 120;
          description = "Live cache TTL in seconds for bookmark sync job.";
        };

        refresh = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Pass --refresh to bookmark job.";
        };

        logPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional --log path override.";
        };

        stdoutPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stdout redirection path for the systemd service.";
        };

        stderrPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stderr redirection path for the systemd service.";
        };
      };

      digest = {
        enable = lib.mkEnableOption "Periodic birdclaw digest generation timer.";

        intervalSeconds = lib.mkOption {
          type = lib.types.ints.positive;
          default = 60 * 60;
          description = "Digest generation interval in seconds.";
        };

        windowHours = lib.mkOption {
          type = lib.types.ints.positive;
          default = 6;
          description = "Number of hours to look back for the digest window.";
        };

        period = lib.mkOption {
          type = lib.types.nullOr (lib.types.enum [
            "today"
            "24h"
            "yesterday"
            "week"
          ]);
          default = null;
          description = "Period preset (overrides --window-hours).";
        };

        account = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Account id to use for the digest job.";
        };

        includeDms = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Include private DM context in the digest.";
        };

        model = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "OpenAI model id for the digest.";
        };

        language = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Report language as a Unicode locale id.";
        };

        maxTweets = lib.mkOption {
          type = lib.types.nullOr lib.types.ints.positive;
          default = null;
          description = "Maximum tweet context for the digest.";
        };

        maxLinks = lib.mkOption {
          type = lib.types.nullOr lib.types.ints.positive;
          default = null;
          description = "Maximum linked articles for the digest.";
        };

        logPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional --log path override.";
        };

        stdoutPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stdout redirection path for the systemd service.";
        };

        stderrPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Optional stderr redirection path for the systemd service.";
        };
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      cfg.package
      pkgs.unzip
    ];

    systemd.user.services.birdclaw = {
      description = "Birdclaw local Twitter memory";
      wantedBy = [ "default.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        BIRDCLAW_HOME = cfg.dataDir;
        BIRDCLAW_ALLOW_REMOTE_WEB = if cfg.allowRemoteWeb then "1" else "0";
        BIRDCLAW_HOST = cfg.host;
        BIRDCLAW_PORT = toString cfg.port;
        BIRDCLAW_CONFIG = "${cfg.dataDir}/config.json";
      };
      serviceConfig = {
        Type = "simple";
        ExecStartPre = [
          ''${lib.getExe' pkgs.coreutils "mkdir"} -p "${cfg.dataDir}"''
          ''${lib.getExe pkgs.bash} -c "[ -f ${cfg.dataDir}/config.json ] || ${lib.getExe' pkgs.coreutils "cp"} ${generatedConfigPath} ${cfg.dataDir}/config.json"''
        ];
        ExecStart = "${lib.getExe' cfg.package "birdclaw"} serve";
        Restart = "always";
        RestartSec = 10;
        PrivateTmp = true;
        NoNewPrivileges = true;
        EnvironmentFile = cfg.environmentFiles;
      };
    };

    systemd.user.services.birdclaw-account-sync = lib.mkIf cfg.jobs.accountSync.enable {
      description = "Birdclaw account sync scheduler job";
      environment = {
        BIRDCLAW_HOME = cfg.dataDir;
        BIRDCLAW_CONFIG = "${cfg.dataDir}/config.json";
        BIRDCLAW_HOST = cfg.host;
        BIRDCLAW_PORT = toString cfg.port;
      };
      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = cfg.environmentFiles;
        StandardOutput =
          if cfg.jobs.accountSync.stdoutPath != null then
            "append:${cfg.jobs.accountSync.stdoutPath}"
          else
            "journal";
        StandardError =
          if cfg.jobs.accountSync.stderrPath != null then
            "append:${cfg.jobs.accountSync.stderrPath}"
          else
            "journal";
        ExecStart = mkAccountSyncCommand {
          inherit (cfg.jobs.accountSync)
            account
            steps
            mode
            limit
            maxPages
            cacheTtlSeconds
            logPath
            refresh
            ;
        };
        NoNewPrivileges = true;
      };
      after = [
        "network-online.target"
        "birdclaw.service"
      ];
      wants = [
        "network-online.target"
        "birdclaw.service"
      ];
      unitConfig = {
        StartLimitIntervalSec = "1m";
        StartLimitBurst = 3;
      };
    };

    systemd.user.timers.birdclaw-account-sync = lib.mkIf cfg.jobs.accountSync.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1m";
        OnUnitActiveSec = "${toString cfg.jobs.accountSync.intervalSeconds}s";
        Unit = "birdclaw-account-sync.service";
        Persistent = true;
      };
    };

    systemd.user.services.birdclaw-bookmark-sync = lib.mkIf cfg.jobs.bookmarkSync.enable {
      description = "Birdclaw bookmark sync scheduler job";
      environment = {
        BIRDCLAW_HOME = cfg.dataDir;
        BIRDCLAW_CONFIG = "${cfg.dataDir}/config.json";
        BIRDCLAW_HOST = cfg.host;
        BIRDCLAW_PORT = toString cfg.port;
      };
      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = cfg.environmentFiles;
        StandardOutput =
          if cfg.jobs.bookmarkSync.stdoutPath != null then
            "append:${cfg.jobs.bookmarkSync.stdoutPath}"
          else
            "journal";
        StandardError =
          if cfg.jobs.bookmarkSync.stderrPath != null then
            "append:${cfg.jobs.bookmarkSync.stderrPath}"
          else
            "journal";
        ExecStart = mkBookmarkSyncCommand cfg.jobs.bookmarkSync;
        NoNewPrivileges = true;
      };
      after = [
        "network-online.target"
        "birdclaw.service"
      ];
      wants = [
        "network-online.target"
        "birdclaw.service"
      ];
      unitConfig = {
        StartLimitIntervalSec = "1m";
        StartLimitBurst = 3;
      };
    };

    systemd.user.timers.birdclaw-bookmark-sync = lib.mkIf cfg.jobs.bookmarkSync.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1m";
        OnUnitActiveSec = "${toString cfg.jobs.bookmarkSync.intervalSeconds}s";
        Unit = "birdclaw-bookmark-sync.service";
        Persistent = true;
      };
    };

    systemd.user.services.birdclaw-digest = lib.mkIf cfg.jobs.digest.enable {
      description = "Birdclaw digest generation scheduler job";
      environment = {
        BIRDCLAW_HOME = cfg.dataDir;
        BIRDCLAW_CONFIG = "${cfg.dataDir}/config.json";
        BIRDCLAW_HOST = cfg.host;
        BIRDCLAW_PORT = toString cfg.port;
      };
      serviceConfig = {
        Type = "oneshot";
        EnvironmentFile = cfg.environmentFiles;
        StandardOutput =
          if cfg.jobs.digest.stdoutPath != null then
            "append:${cfg.jobs.digest.stdoutPath}"
          else
            "journal";
        StandardError =
          if cfg.jobs.digest.stderrPath != null then
            "append:${cfg.jobs.digest.stderrPath}"
          else
            "journal";
        ExecStart = mkDigestCommand cfg.jobs.digest;
        NoNewPrivileges = true;
      };
      after = [
        "network-online.target"
        "birdclaw.service"
      ];
      wants = [
        "network-online.target"
        "birdclaw.service"
      ];
      unitConfig = {
        StartLimitIntervalSec = "1m";
        StartLimitBurst = 3;
      };
    };

    systemd.user.timers.birdclaw-digest = lib.mkIf cfg.jobs.digest.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1m";
        OnUnitActiveSec = "${toString cfg.jobs.digest.intervalSeconds}s";
        Unit = "birdclaw-digest.service";
        Persistent = true;
      };
    };
  };
}
