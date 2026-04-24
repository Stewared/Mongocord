<img src="./assets/separator.svg" width="2000">
<br>
<br>
<p align="center">
  <img src="./assets/Mongocord.png" alt="Mongocord" width="125" />
</p>

# Mongocord - A Discord MongoDB Client

A Discord Bot MongoDB client. Designed to function similarly to MongoDB Compass, Mongocord supports managing your local or remote atlas databases.

<img src="./assets/separator.svg" width="2000">


## What it does

- `/find`
  - Opens the standard modal with projection, filter, and sort abilities.
  - Results are displayed like MongoDB and can be easily edited.

- `/aggregation create|edit|run|delete|import`
  - Saves pipelines per user.
  - Shows a paginated stage editor with edit, enable/disable, move, import, and export controls.
  - Runs the pipeline inside Discord and shows a paginated read-only result view with downloads.

- `/import`
  - Import documents in JSON format into Mongo, just like Compass.

- `/database create|rename|delete|list`
  - Manage databases

- `/collection create|rename|delete|list`
  - Manage collections

- `/config`
  - `confirmations` by default, Mongocord will confirm before editing or deleting.
  - `admin_add`, `admin_remove`, and `admin_list` manage who can use Mongocord.

<img src="./assets/separator.svg" width="2000">

## Setup

1. Copy `example.env.jsonc` to `env.json`.
2. Fill in:
   - `token`
   - `clientId`
   - `mongoUri`
   - `devAdmins`
3. Install dependencies:

```bash
npm install
```

4. Register commands:

```bash
npm run register
```

5. Start the bot:

```bash
npm start
```

<img src="./assets/separator.svg" width="2000">

## Demo:
