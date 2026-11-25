# NixOS VM test: the module starts Tally on a local Postgres, creates its tables, serves the app,
# and passkey sign-in works under the service's sandboxing.
#   nix-build nix/test.nix
{
  pkgs ? import <nixpkgs> { },
}:

let
  # Stands in for a phone: makes a passkey on the setup screen's endpoints, then prints the session
  # cookie. Plain http is fine on localhost, as in browsers.
  passkeyClient = pkgs.writers.writePython3Bin "passkey-client" {
    libraries = [ pkgs.python3Packages.cryptography ];
  } ''
    import base64
    import hashlib
    import json
    import urllib.request

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    ORIGIN = "http://localhost:8080"


    def b64(b):
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


    def post(path, body):
        req = urllib.request.Request(
            ORIGIN + path,
            data=json.dumps(body).encode(),
            headers={"Origin": ORIGIN, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as res:
            return json.load(res), res.headers.get("Set-Cookie")


    key = ec.generate_private_key(ec.SECP256R1())
    challenge = post("/auth/challenge", {})[0]["challenge"]
    client_data = json.dumps(
        {"type": "webauthn.create", "challenge": challenge, "origin": ORIGIN}
    ).encode()
    # rpIdHash, flags (user present and verified), signature counter
    auth_data = hashlib.sha256(b"localhost").digest() + bytes([5, 0, 0, 0, 0])
    spki = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    body = {
        "id": b64(b"vm-test-passkey"),
        "publicKey": b64(spki),
        "clientDataJson": b64(client_data),
        "authenticatorData": b64(auth_data),
    }
    state, cookie = post("/auth/register", body)
    assert state["state"] == "signed-in", state
    print(cookie.split(";")[0])
  '';
in
pkgs.testers.runNixOSTest {
  name = "tally";

  nodes.machine = {
    imports = [ ./module.nix ];
    services.tally = {
      enable = true;
      passkey.enable = true;
    };
    environment.systemPackages = [ passkeyClient ];
  };

  testScript = ''
    machine.wait_for_unit("tally.service")
    machine.wait_for_open_port(8080)
    machine.succeed("curl -fs http://localhost:8080/ | grep -q '<title>Tally</title>'")
    machine.succeed("test $(sudo -u postgres psql -d tally -tAc 'select count(*) from seaql_migrations') -gt 0")

    # A gRPC-web call with an empty request message; prints the headers and the body (trailers).
    machine.succeed("head -c 5 /dev/zero > /tmp/empty-message")
    api = "curl -s -D - -X POST -H 'Content-Type: application/grpc-web+proto' --data-binary @/tmp/empty-message http://localhost:8080/finance.AccountService/ListAccounts"
    status = "curl -fs http://localhost:8080/auth/status"

    # A new Tally waits for its passkey, and the API stays shut until then.
    machine.succeed(f"{status} | grep -q setup")
    machine.succeed(f"{api} | grep -qi 'grpc-status: 16'")

    # Setting up saves the passkey where only Tally can read it, and signs in.
    cookie = machine.succeed("passkey-client").strip()
    machine.succeed("test $(stat -c %a /var/lib/tally/passkey.json) = 600")
    machine.succeed("test $(stat -c %U /var/lib/tally/passkey.json) = tally")
    machine.succeed(f"{api} -H 'Cookie: {cookie}' | grep -aq 'grpc-status:0'")
    machine.fail("passkey-client")  # the first passkey is the only one

    # Sessions survive a restart (which also runs the migrations again, as a no-op).
    machine.systemctl("restart tally.service")
    machine.wait_for_unit("tally.service")
    machine.wait_for_open_port(8080)
    machine.succeed(f"{status} -H 'Cookie: {cookie}' | grep -q signed-in")

    # Deleting the file signs everyone out and brings back setup.
    machine.succeed("rm /var/lib/tally/passkey.json")
    machine.succeed(f"{status} -H 'Cookie: {cookie}' | grep -q setup")
    machine.succeed("passkey-client")
  '';
}
