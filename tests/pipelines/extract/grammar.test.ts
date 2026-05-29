import { describe, test, expect } from "bun:test";
import { detectLanguage } from "../../../src/pipelines/extract/grammar";

describe("detectLanguage", () => {
  test("maps .ts to typescript", () => {
    expect(detectLanguage("/project/src/auth.ts")).toBe("typescript");
  });

  test("maps .tsx to typescript", () => {
    expect(detectLanguage("/project/src/App.tsx")).toBe("typescript");
  });

  test("maps .py to python", () => {
    expect(detectLanguage("/project/main.py")).toBe("python");
  });

  test("maps .rs to rust", () => {
    expect(detectLanguage("/project/src/main.rs")).toBe("rust");
  });

  test("maps .go to go", () => {
    expect(detectLanguage("/project/main.go")).toBe("go");
  });

  test("maps .java to java", () => {
    expect(detectLanguage("/project/App.java")).toBe("java");
  });

  test("maps .js to javascript", () => {
    expect(detectLanguage("/project/index.js")).toBe("javascript");
  });

  test("maps .jsx to javascript", () => {
    expect(detectLanguage("/project/App.jsx")).toBe("javascript");
  });

  test("maps .rb to ruby", () => {
    expect(detectLanguage("/project/app.rb")).toBe("ruby");
  });

  test("maps .swift to swift", () => {
    expect(detectLanguage("/project/App.swift")).toBe("swift");
  });

  test("maps .kt to kotlin", () => {
    expect(detectLanguage("/project/Main.kt")).toBe("kotlin");
  });

  test("maps .c to c", () => {
    expect(detectLanguage("/project/main.c")).toBe("c");
  });

  test("maps .cpp to cpp", () => {
    expect(detectLanguage("/project/main.cpp")).toBe("cpp");
  });

  test("maps .cs to c_sharp", () => {
    expect(detectLanguage("/project/Program.cs")).toBe("c_sharp");
  });

  test("returns null for unknown extension", () => {
    expect(detectLanguage("/project/data.xyz")).toBeNull();
  });

  test("returns null for no extension", () => {
    expect(detectLanguage("/project/Makefile")).toBeNull();
  });

  test("handles dotfiles", () => {
    expect(detectLanguage("/project/.gitignore")).toBeNull();
  });
});
