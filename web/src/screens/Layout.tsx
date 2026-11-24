import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";

import { auth, errorMessage } from "../api";
import { SheetHost, useSheets } from "../sheets/context";
import { useAccountRoles, useAccounts, useUncategorized } from "../queries";
import { potIcon } from "../ui/TransferMenu";
import { Icon, IconSprite } from "../ui/Icon";
import { useAuthState } from "./SignIn";

export function Layout() {
  return (
    <SheetHost>
      <Shell />
    </SheetHost>
  );
}

function Shell() {
  const accounts = useAccounts();
  const uncategorized = useUncategorized().data?.length ?? 0;
  const open = useSheets();
  const location = useRouterState({ select: (s) => s.location });
  const roles = useAccountRoles();
  const activeAccount = location.pathname === "/transactions" ? (location.search as { account?: number }).account : undefined;
  const activePot = location.pathname === "/pots" ? (location.search as { id?: number }).id : undefined;
  const signedIn = useAuthState().data === "signed-in";
  const qc = useQueryClient();
  const signOut = async () => {
    await auth.signOut();
    qc.setQueryData(["auth"], "signed-out"); // brings up the sign-in screen
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" }); // and forgets the data
  };

  return (
    <div className="app">
      <IconSprite />
      <aside className="sb">
        <div className="brand"><span className="logo" aria-hidden="true" />Tally</div>
        <nav aria-label="Main">
          <Link to="/" activeOptions={{ exact: true, includeSearch: false }} activeProps={{ className: "on" }}>
            <Icon name="overview" /><span>Overview</span>
          </Link>
          <Link to="/transactions" activeOptions={{ includeSearch: false }} activeProps={{ className: activeAccount == null ? "on" : "" }}>
            <Icon name="list" /><span>Transactions</span>
          </Link>
          <Link to="/inbox" activeProps={{ className: "on" }}>
            <Icon name="tray" /><span>To Categorize</span>
            {uncategorized > 0 && <span className="attn">{uncategorized > 999 ? "999+" : uncategorized}</span>}
          </Link>
          <div className="h">Manage</div>
          <button type="button" onClick={() => open({ kind: "import" })}>
            <Icon name="import" /><span>Import</span>
          </button>
          <button type="button" onClick={() => open({ kind: "categories" })}>
            <Icon name="tag" /><span>Categories</span>
          </button>
          <button type="button" className="rules-link" onClick={() => open({ kind: "rules" })}>
            <Icon name="sparkle" /><span>Rules</span>
          </button>
          {signedIn && (
            <button type="button" className="signout-link" onClick={signOut}>
              <Icon name="signout" /><span>Sign Out</span>
            </button>
          )}
          {(roles?.banks.length ?? 0) > 0 && <div className="h accounts-h">Accounts</div>}
          {roles?.banks.map((a) => (
            <Link key={a.id} to="/transactions" search={{ account: a.id }} className={`account ${activeAccount === a.id ? "on" : ""}`}>
              <Icon name={/amex|american|card|creditcard/i.test(a.name) ? "card" : "bank"} />
              <span className="ellipsis">{a.name}</span>
            </Link>
          ))}
          {roles && (
            <div className="h accounts-h with-action">
              Savings &amp; Cash
              <button type="button" className="icon-btn" aria-label="New pot" onClick={() => open({ kind: "pot" })}><Icon name="plus" /></button>
            </div>
          )}
          {roles?.pots.map((a) => (
            <Link key={a.id} to="/pots" search={{ id: a.id }} className={`account ${activePot === a.id ? "on" : ""}`}>
              <Icon name={potIcon(a)} />
              <span className="ellipsis">{a.name}</span>
            </Link>
          ))}
        </nav>
      </aside>
      <main className="main">
        {accounts.isError ? (
          <div className="fatal">
            <b>Can't load your data</b>
            <p>{errorMessage(accounts.error)}</p>
            <button className="btn" onClick={() => accounts.refetch()}>Try Again</button>
          </div>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
