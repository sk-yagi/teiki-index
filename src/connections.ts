import { scheduler } from "timers/promises";

import { S3Client } from "@aws-sdk/client-s3";
import {
  createInteractionContext,
  InteractionContext,
  ServerNotReady,
} from "@cardano-ogmios/client";
import * as discord from "discord.js";
import { GatewayIntentBits } from "discord.js";
import * as IpfsClient from "ipfs-http-client";
import { Lucid, Network as LucidNetwork } from "lucid-cardano";

import { assert } from "@teiki/protocol/utils";

import * as config from "./config";
import * as db from "./db";
import { createNotificationsService, Notifications } from "./db/notifications";
import { createViewsController, ViewsController } from "./db/views";
import { MaybePromise } from "./types/typelevel";

export type AllConnections = {
  readonly sql: db.Sql;
  readonly ogmios: InteractionContext;
  readonly ipfs: IpfsClient.IPFSHTTPClient;
  readonly lucid: Lucid;
  readonly discord: discord.Client<boolean>;
  readonly s3: S3Client;
  readonly notifications: Notifications;
  readonly views: ViewsController;
};

export type ConnectionKey = keyof AllConnections;

export type Connections<K extends ConnectionKey> = {
  [P in K]: AllConnections[P];
};

type Registration<K extends ConnectionKey> = {
  readonly instruction: {
    connect: () => MaybePromise<AllConnections[K]>;
    disconnect?: (self: AllConnections[K]) => MaybePromise<void>;
  };
  connection?: Promise<AllConnections[K]>;
};

const registry: { [K in ConnectionKey]?: Registration<K> } = {};

const cleanups: [ConnectionKey, () => MaybePromise<void>][] = [];

let disconnecting: ConnectionKey | undefined = undefined;

export function register<K extends ConnectionKey>(
  key: K,
  instruction: Registration<K>["instruction"]
) {
  assert(
    registry[key] === undefined,
    `Connection <${key}> is already registered.`
  );
  (registry[key] as Registration<K>) = { instruction };
}

export function deregister<K extends ConnectionKey>(key: K) {
  if (registry[key] === undefined)
    console.warn(`Connection <${key}> is already deregistered.`);
  delete registry[key];
}

export async function provide<K extends ConnectionKey>(
  ...keys: K[]
): Promise<Connections<K>> {
  return Object.fromEntries(
    await Promise.all(keys.map(async (key) => [key, await provideOne(key)]))
  );
}

export async function provideOne<K extends ConnectionKey>(
  key: K
): Promise<AllConnections[K]> {
  const reg = registry[key];
  assert(reg !== undefined, `Connection <${key}> is not registered yet!`);
  if (reg.connection === undefined)
    reg.connection = (async function () {
      console.log(`<${key}> Connecting...`);
      const connection = await reg.instruction.connect();
      const disconnect = reg.instruction.disconnect;
      if (disconnect !== undefined)
        cleanups.push([
          key,
          async () => {
            console.log(`<${key}> Disconnecting...`);
            disconnecting = key;
            await disconnect(connection);
            disconnecting = undefined;
            console.log(`<${key}> Disconnected!`);
          },
        ]);
      console.log(`<${key}> Connected!`);
      return connection;
    })();
  return reg.connection;
}

export async function cleanup(): Promise<
  { key: ConnectionKey; error: unknown }[]
> {
  const errors = [];
  for (const [key, cleanup] of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.error(error);
      errors.push({ key, error });
    }
  }
  return errors;
}

// Connections setup
register("sql", {
  connect: () => {
    const cc = config.database();
    return db.postgres(
      cc.DATABASE_URL,
      db.options({ max: cc.DATABASE_MAX_CONNECTIONS })
    );
  },
  disconnect: async (self) => self.end({ timeout: 10 }),
});

register("ogmios", {
  connect: async () => {
    function onClientError(error: Error) {
      console.error("<ogmios> Error:", error);
      throw error;
    }

    function onClientClose(code: number, reason: string) {
      const message = `<ogmios> Close (${code}) ${reason}`;
      if (disconnecting === "ogmios") console.warn(message);
      else throw new Error(message);
    }

    const cc = config.ogmios();
    for (;;) {
      try {
        return await createInteractionContext(onClientError, onClientClose, {
          connection: cc,
          interactionType: "LongRunning",
        });
      } catch (e) {
        if (e instanceof ServerNotReady) {
          console.warn(`<ogmios> Wait until Ogmios is ready :: ${e.message}`);
          await scheduler.wait(5_000);
        } else throw e;
      }
    }
  },
  disconnect: ({ socket }) => {
    return new Promise((resolve, reject) => {
      switch (socket.readyState) {
        case socket.CONNECTING:
          console.warn("<ogmios> just connecting...");
          socket.once("close", () => resolve());
          socket.once("error", (e) => reject(e));
          return socket.close();
        case socket.OPEN:
          socket.once("close", () => resolve());
          socket.once("error", (e) => reject(e));
          return socket.close();
        case socket.CLOSING:
          console.warn("<ogmios> already closing...");
          return resolve();
        case socket.CLOSED:
          console.warn("<ogmios> already closed...");
          return resolve();
      }
    });
  },
});

register("ipfs", {
  connect: () => {
    const cc = config.ipfs();
    return IpfsClient.create({
      url: cc.IPFS_SERVER_URL,
      timeout: cc.IPFS_SERVER_TIMEOUT,
    });
  },
});

register("lucid", {
  connect: () => {
    const network = config.cardano().NETWORK;
    return Lucid.new(
      undefined,
      (network.charAt(0).toUpperCase() + network.substring(1)) as LucidNetwork
    );
  },
});

register("discord", {
  connect: async () => {
    const client = new discord.Client({
      intents: [GatewayIntentBits.DirectMessages],
      partials: [discord.Partials.Channel],
    });
    const { DISCORD_BOT_TOKEN } = config.discord();
    await client.login(DISCORD_BOT_TOKEN);
    return client;
  },
  disconnect: (self) => self.destroy(),
});

register("notifications", {
  connect: async () => createNotificationsService(await provideOne("sql")),
  disconnect: (self) => self.shutdown(),
});

register("views", {
  connect: async () =>
    createViewsController(await provideOne("sql"), {
      views: {
        "views.project_custom_url": { concurrently: true },
        "views.project_summary": { concurrently: true, debounce: 1_000 },
      },
    }),
  disconnect: (self) => self.shutdown(),
});

register("s3", {
  connect: () => new S3Client({}),
  disconnect: (self) => self.destroy(),
});
