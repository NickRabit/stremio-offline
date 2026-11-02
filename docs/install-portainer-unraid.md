# Portainer and Unraid templates

The repository ships templates for Portainer and Unraid Community Applications.
They install the prebuilt image and expose the same persistent data and download
folders as the Compose setup.

Neither template stores a password. Open the Web UI after the first start and
create the administrator account there.

## Portainer

Portainer loads custom templates from a JSON feed. To add Stremio Offline:

1. In Portainer, open **Settings -> General** and set **App Templates** to:

   ```text
   https://raw.githubusercontent.com/NickRabit/stremio-offline/main/deploy/portainer/templates.json
   ```

2. Open **Templates**, select **Stremio Offline**, and set the web port,
   persistent data folder, download folder, timezone and user/group IDs.
3. Deploy the stack and open `http://<docker-host>:8090`, unless another web
   port was selected.

The template source is
[`deploy/portainer/templates.json`](../deploy/portainer/templates.json), and
the stack it deploys is
[`deploy/portainer/docker-compose.yml`](../deploy/portainer/docker-compose.yml).

The default stack works without a GPU. For Intel QuickSync or VAAPI, edit the
generated stack and add:

```yaml
devices:
  - /dev/dri:/dev/dri
```

Set the **Render group ID** field (`RENDER_GID`) to the group that owns
`/dev/dri/renderD128`; see
[Hardware acceleration](hardware-acceleration.md) for the full check. Hosts
without `/dev/dri` must leave the device out.

Portainer requires the one-time template-feed URL because this project is not
part of Portainer's built-in catalogue. After the feed is configured, each
deployment starts from the normal Portainer template form.

## Unraid

The Community Applications template is
[`templates/stremio-offline.xml`](../templates/stremio-offline.xml), with the
required repository profile in [`ca_profile.xml`](../ca_profile.xml).
It installs the GHCR image, stores application data under
`/mnt/user/appdata/stremio-offline`, stores downloads under
`/mnt/user/downloads/stremio-offline`, and exposes the user/group, timezone and
private-addon settings in Unraid's normal container form. Add `/dev/dri` as a
device in Advanced View when the host supports Intel QuickSync or VAAPI, and set
**Render Group ID** to the group that owns `/dev/dri/renderD128`.

The template is prepared as the source for submission but is not yet
guaranteed to appear in the Community Applications catalogue. Until it is
listed, use the Compose installation in the main README or install the same
image with Unraid's **Docker -> Add Container** form. Community Applications
serves templates after the repository has passed its publishing review; the
official submission workflow is at <https://ca.unraid.net/submit>.

Do not copy a hand-edited XML file into Unraid's user-template directory as a
shortcut. The Community Applications maintainers require templates produced by
Unraid's own template generator and may reject or blacklist malformed copies.
The checked-in file is the source for that submission and for a future app tile.

## Updating

The templates pull `ghcr.io/nickrabit/stremio-offline:latest`. Users who need
reproducible releases can replace `latest` with a published version tag in the
template or generated stack. The persistent data folder survives both methods.
