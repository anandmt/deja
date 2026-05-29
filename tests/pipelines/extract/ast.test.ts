import { describe, test, expect, afterEach } from "bun:test";
import { extractAst } from "../../../src/pipelines/extract/ast";
import { GrammarManager } from "../../../src/pipelines/extract/grammar";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function setupManager(lang: string): Promise<{ manager: GrammarManager; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "deja-ast-test-"));
  const resp = await fetch(
    `https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-${lang}.wasm`
  );
  writeFileSync(join(dir, `tree-sitter-${lang}.wasm`), Buffer.from(await resp.arrayBuffer()));
  return { manager: new GrammarManager(dir), dir };
}

describe("extractAst", () => {
  let cleanupDir: string | null = null;
  afterEach(() => {
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = null;
  });

  test("extracts TypeScript functions and classes", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;

    const code = `
export function validateToken(token: string): boolean {
  return token.length > 0;
}

export class AuthService {
  refreshSession() {}
  logout() {}
}

interface UserPayload {
  id: string;
}

enum Role {
  Admin,
  User,
}
`;

    const symbols = await extractAst(code, "/project/src/auth.ts", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("validateToken");
    expect(symbols).toContain("AuthService");
    expect(symbols).toContain("refreshSession");
    expect(symbols).toContain("logout");
    expect(symbols).toContain("UserPayload");
    expect(symbols).toContain("Role");
  });

  test("extracts Python functions and classes", async () => {
    const { manager, dir } = await setupManager("python");
    cleanupDir = dir;

    const code = `
def process_payment(amount: float) -> bool:
    return amount > 0

class PaymentGateway:
    def charge(self, amount):
        pass

    def refund(self, tx_id):
        pass
`;

    const symbols = await extractAst(code, "/project/payments.py", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("process_payment");
    expect(symbols).toContain("PaymentGateway");
    expect(symbols).toContain("charge");
    expect(symbols).toContain("refund");
  });

  test("returns null for unsupported file extension", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("some content", "/project/data.xyz", manager);
    expect(result).toBeNull();
  });

  test("returns null for empty content", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("", "/project/empty.ts", manager);
    expect(result).toBeNull();
  });

  test("returns empty array for file with no declarations", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const result = await extractAst("const x = 1 + 2;\nconsole.log(x);", "/project/script.ts", manager);
    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });

  test("extracts Go functions and type declarations", async () => {
    const { manager, dir } = await setupManager("go");
    cleanupDir = dir;

    const code = `package main

func HandleRequest(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}

type Config struct {
	Port int
	Host string
}

type Handler interface {
	ServeHTTP()
}
`;

    const symbols = await extractAst(code, "/project/main.go", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("HandleRequest");
    expect(symbols).toContain("Config");
    expect(symbols).toContain("Handler");
  });

  test("extracts Rust functions, structs, and enums", async () => {
    const { manager, dir } = await setupManager("rust");
    cleanupDir = dir;

    const code = `
pub fn process_event(ev: &Event) -> Result<()> {
    Ok(())
}

struct Config {
    port: u16,
}

enum Status {
    Active,
    Inactive,
}
`;

    const symbols = await extractAst(code, "/project/src/main.rs", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("process_event");
    expect(symbols).toContain("Config");
    expect(symbols).toContain("Status");
  });

  test("extracts Java classes and methods", async () => {
    const { manager, dir } = await setupManager("java");
    cleanupDir = dir;

    const code = `
public class UserService {
    public User findById(String id) {
        return null;
    }

    public void deleteUser(String id) {
    }
}
`;

    const symbols = await extractAst(code, "/project/UserService.java", manager);
    expect(symbols).not.toBeNull();
    expect(symbols).toContain("UserService");
    expect(symbols).toContain("findById");
    expect(symbols).toContain("deleteUser");
  });

  test("deduplicates symbol names", async () => {
    const { manager, dir } = await setupManager("typescript");
    cleanupDir = dir;
    const code = `
function process(a: string): void;
function process(a: number): void;
function process(a: string | number): void {}
`;
    const symbols = await extractAst(code, "/project/overload.ts", manager);
    expect(symbols).not.toBeNull();
    const processCount = symbols!.filter(s => s === "process").length;
    expect(processCount).toBe(1);
  });
});
