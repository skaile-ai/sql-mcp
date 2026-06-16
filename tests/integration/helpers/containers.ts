// Spins up throwaway DB containers for live integration tests. Only imported by
// *.live.test.ts, which run solely under `bun run test:integration` (RUN_DB_INTEGRATION=1).
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export const LIVE = !!process.env.RUN_DB_INTEGRATION;

export async function startPostgres(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_PASSWORD: "secret", POSTGRES_DB: "appdb" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const dsn = `postgresql://postgres:secret@${container.getHost()}:${container.getMappedPort(5432)}/appdb`;
  return { container, dsn };
}

export async function startMysql(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("mysql:8.0")
    .withEnvironment({ MYSQL_ROOT_PASSWORD: "secret", MYSQL_DATABASE: "appdb" })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
    .withStartupTimeout(120_000)
    .start();
  const dsn = `mysql://root:secret@${container.getHost()}:${container.getMappedPort(3306)}/appdb`;
  return { container, dsn };
}

export async function startMssql(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("mcr.microsoft.com/mssql/server:2022-latest")
    .withEnvironment({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: "Str0ng!Passw0rd" })
    .withExposedPorts(1433)
    .withWaitStrategy(Wait.forLogMessage(/SQL Server is now ready for client connections/, 1))
    .withStartupTimeout(180_000)
    .start();
  const dsn = `mssql://sa:Str0ng!Passw0rd@${container.getHost()}:${container.getMappedPort(1433)}/master`;
  return { container, dsn };
}
