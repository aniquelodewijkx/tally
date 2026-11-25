# Tally

A personal finance tracker for your bank and credit-card exports. Tally shows what things really
cost you: the credit-card bill counts once (the purchases are the spending, not the bill), and money
friends pay back by Tikkie comes off the expense it pays back.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="The year overview: spending per category for each month, with a table of the same numbers below" src="docs/screenshots/overview-light.png">
</picture>

<sub>All screenshots show made-up demo data from <a href="web/demo"><code>web/demo</code></a>.</sub>

## What it does

### See where your money goes

The **year view** stacks each month's spending by category. Click a pie slice to open that
category's subcategory charts, or turn categories on and off in the year chart to compare them.
The **month view** shows where the money went, how each category compares with the month before,
and what was moved to savings or investments instead of spent.

Tag expense categories **Fixed** to see fixed and non-fixed monthly averages and switch the
spending-share pie between all, fixed and non-fixed costs. Tag a category **Yearly cost** to leave
it out of monthly averages and charts; its total stays visible in the year view. Both tags apply
to subcategories and can be changed in **Categories**.

<table>
  <tr>
    <td width="50%"><img alt="Food broken down into groceries and dining out per month" src="docs/screenshots/drill.png"></td>
    <td width="50%"><img alt="October: spending per category with the change from September" src="docs/screenshots/month.png"></td>
  </tr>
</table>

### Link what belongs together

- **Paid back.** Link the Tikkies for a dinner or a trip to what you paid. They take the expense's
  category, so the category shows your share. One payment can pay back several expenses, and you
  can add more payments later, from any month.
- **Transfers.** Paying the credit-card bill from your bank account is a transfer between your own
  accounts, not spending. Tally suggests these pairs for you.
- **Pots.** Savings or investment accounts you don't import. Money moved there is a transfer, and
  each pot has its own page.
- **Splits.** Divide one payment over several categories.

<table>
  <tr>
    <td width="50%"><img alt="Linking two Tikkies to a sushi dinner, leaving a share of 32 euros" src="docs/screenshots/link.png"></td>
    <td width="50%"><img alt="A birthday dinner with three payments back and your share" src="docs/screenshots/transactions.png"></td>
  </tr>
</table>

### Label once

- **Rules** label new transactions automatically: "counterparty contains *versmarkt* → Groceries",
  or "→ transfer to Savings". A rule can be limited to money in or out, one account, or an amount
  range. Before you save one, Tally shows every transaction it would cover. After you label
  something by hand, it offers to make a rule for it.
- **To Categorize** walks through what's left, transfer suggestions first, with keyboard shortcuts.

<table>
  <tr>
    <td width="50%"><img alt="The rules, grouped by category, with the transactions one rule covers" src="docs/screenshots/rules.png"></td>
    <td width="50%"><img alt="To Categorize, suggesting that a bank payment and a card payment are the same transfer" src="docs/screenshots/inbox.png"></td>
  </tr>
</table>

### Quick to work through

<img align="right" width="230" alt="October on a phone, in dark mode" src="docs/screenshots/phone.png">

- **Import** an ING export (English CSV) or a credit-card export (`Datum,Omschrijving,Bedrag`).
  Overlapping exports don't create duplicates, and an import can be undone.
- **Categorize fast:** pick a category, press Enter, and the next transaction's picker opens.
- **Select several** transactions (⌘/Ctrl-click, Shift-click) to categorize, link or mark them
  as transfers at once.
- **Filter and search** by category, account or text, across all months.
- **Light and dark mode**, and a layout for your phone.

<br clear="right">

## How it's built

- **Backend:** Rust (tokio, tonic, SeaORM on Postgres). The API is defined in [`proto/finance`](proto/finance).
- **Frontend:** React + TypeScript in [`web/`](web), talking gRPC-web to the same server.
- **Design:** [`docs/data-model`](docs/data-model/index.html) and [`docs/mockups`](docs/mockups/index.html).

## Development

The dev shell (`direnv allow`, or `devenv shell`) provides Rust (through the mbx build cache), Node,
buf, sea-orm-cli and Postgres.

```sh
devenv up                       # local Postgres on 127.0.0.1:5432, database "finance"
cargo run -p tally-server       # API on 127.0.0.1:8080, runs migrations on start
cd web && npm install && npm run dev   # frontend on :5173, proxies the API
demo                            # made-up data on a throwaway database at 127.0.0.1:18080
```

After changing the schema in `crates/migration`, run `generate-entities`. After changing a
`.proto` file, run `npm run generate` in `web/`. Both outputs are checked in. Conventions and
what every pull request needs are in [AGENTS.md](AGENTS.md).

## Tests

```sh
test-all                        # Rust tests on a throwaway Postgres
buf lint proto
cd web && npm run typecheck && npm test
```

## Running it

```sh
cd web && npm run build         # writes web/dist
cargo run --release -p tally-server
```

The `tally` binary serves the API and the built frontend on one port. Configuration comes from the
environment: `DATABASE_URL` (required), `LISTEN_ADDR` (default `127.0.0.1:8080`) and `WEB_DIR`
(default `web/dist`). There is no login yet, so anyone who can reach the port sees everything: keep
it on localhost, or on a network only you can reach.

### On NixOS

[`nix/module.nix`](nix/module.nix) runs Tally as a service with its own local Postgres database,
on `127.0.0.1:8080` by default. Import it from a pinned copy of this repo:

```nix
# configuration.nix
let
  tally = builtins.fetchTarball {
    url = "https://github.com/kalmjasper/tally/archive/<commit>.tar.gz";
    sha256 = "<hash>"; # nix-prefetch-url --unpack <url>
  };
in
{
  imports = [ "${tally}/nix/module.nix" ];
  services.tally.enable = true;
}
```

On a flake-based system, add `inputs.tally = { url = "github:kalmjasper/tally"; flake = false; };`
and import `"${inputs.tally}/nix/module.nix"`. `nix flake update tally` then pulls in new versions.
The package on its own is `pkgs.callPackage "${tally}/nix/package.nix" { }`, and
`nix-build nix/test.nix` boots a VM that checks the module works.

## License

Apache License 2.0. See [LICENSE](LICENSE).
