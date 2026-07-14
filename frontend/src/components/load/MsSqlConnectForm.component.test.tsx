import { describe, expect, it } from "vitest";
import {
  connectValuesToSqlProfile,
  mssqlSecretKey,
  sqlProfileToConnectValues,
  type MsSqlConnectValues,
} from "./MsSqlConnectForm";
import type { SqlProfile } from "../../lib/sqlProfiles";

describe("MsSqlConnectForm helpers", () => {
  it("round-trips profile fields and builds mssql secret keys", () => {
    const profile: SqlProfile = {
      driver: "ODBC Driver 18 for SQL Server",
      server: "HOST\\INST",
      port: "1433",
      auth: "sql",
      user: "sa",
      encrypt: true,
      trust: true,
      multiSubnet: false,
      loginTimeout: "15",
      stmtTimeout: "0",
      readOnly: true,
      savePassword: true,
    };
    const values = {
      ...sqlProfileToConnectValues(profile, "Prod"),
    } as MsSqlConnectValues;
    expect(values.server).toBe("HOST\\INST");
    expect(values.multi_subnet).toBe(false);
    expect(values.profile_name).toBe("Prod");
    expect(mssqlSecretKey("Prod")).toBe("mssql:Prod");
    const back = connectValuesToSqlProfile(values);
    expect(back.server).toBe("HOST\\INST");
    expect(back.auth).toBe("sql");
    expect(back.savePassword).toBe(true);
  });
});
