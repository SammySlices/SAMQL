import { describe, expect, it } from "vitest";
import { dropManyConfirmMessage } from "./dropManyConfirm";

describe("dropManyConfirmMessage", () => {
  const local = [
    { engine: "duckdb", name: "a" },
    { engine: "duckdb", name: "b" },
    { engine: "duckdb", name: "c" },
  ];

  it('says "Drop All Tables?" when every local table is selected', () => {
    expect(dropManyConfirmMessage(local, local)).toBe("Drop All Tables?");
  });

  it("lists names when only some tables are selected", () => {
    expect(
      dropManyConfirmMessage(
        [
          { engine: "duckdb", name: "a" },
          { engine: "duckdb", name: "b" },
        ],
        local,
      ),
    ).toBe("Drop 2 tables? This cannot be undone. (a, b)");
  });

  it("uses singular copy for one table", () => {
    expect(
      dropManyConfirmMessage([{ engine: "duckdb", name: "a" }], local),
    ).toBe('Drop 1 table? This cannot be undone. (a)');
  });
});
