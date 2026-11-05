# FBRX Time

**FBRX Time** makes whole-machine image backups and proves they work. An image holds everything: the operating
system, the apps, the settings and the files, so a machine can be put back exactly as it was, even on a new disk.

It works in three places:

| Where | What it does |
| --- | --- |
| **FBRX Server** (the `time` role) | Backs up the server's virtual machines on a schedule while they run, keeps the images computers send it, and **checks every image by starting it** as a throwaway virtual machine. Restores an image as a new virtual machine. |
| **FBRX Endpoint** (Windows, FBRX Endpoint 1.9.8+) | *Backup & restore → Whole computer*: an image of the computer, by hand or on a schedule, to a drive, a network folder or an FBRX Server. |
| **FBRX Command** | *Image backup now* on a device's page, or the `backup.image` command (a device, a group or every device) from *Send command*. Each device's last image shows on its page. |

## The boot check

A backup is only as good as the restore. So after FBRX Time makes or receives an image, it opens it the way a restore
would and watches it start:

1. It makes a **throwaway copy-on-write layer** over each of the image's disks. The image itself is only read; nothing
   the test machine writes reaches it.
2. It starts a **temporary virtual machine** from those layers with **no network card** (it cannot talk to anything,
   so a copy of a server does not answer for the real one), the same firmware as the original (BIOS or UEFI), and its
   screen reachable only from the server itself.
3. It lets the machine run (three minutes by default; *FBRX Time → Settings*), then looks at it:
   * **Still running?** A machine that stops by itself, or never starts, **fails** the check.
   * **The guest agent answered?** When the machine has a guest agent, its answer means the operating system is up.
     That **passes**.
   * **Its screen.** FBRX Time keeps a picture of the screen at the end (*Images → Screen*). A desktop or sign-in
     picture **passes**; a text console or a blank screen gets a **warning** (it started, but someone should look).
4. It **shuts the machine down and deletes it**, and its throwaway layers with it.

Checks run one at a time, after backups, so a busy server is not swamped. *Check* on an image runs one again
whenever you like.

## Virtual machines (FBRX Server)

*FBRX Time → Backup jobs*: one job per virtual machine, with its schedule (every day or every week, at a time, or only
by hand), whether to boot-check each new image, and how many images to keep (older ones are deleted after a new one is
made). *Back up a machine once* makes one image now, without a job.

A running machine is backed up **live**. FBRX Time takes a short snapshot of its disks, copies them while the machine
keeps working, then merges the snapshot back so the machine ends up on its own disks as before. When the machine has a
guest agent, it is asked to pause writes for the moment of the snapshot, so applications and databases are consistent;
without one the copy is like pulling the plug (file systems recover, open databases replay their logs). A machine that
is off is simply copied. Each image says which of these it was.

**Restore** makes a **new** virtual machine from an image, stopped, with its own name and copies of the disks, on the
default network. The original is never touched. Start it when you are ready (and turn the original off first if they
would clash on your network).

## Computers

### On the computer: FBRX Endpoint

*Backup & restore → Whole computer* (Windows):

1. **Where:** *A drive* (an external drive formatted NTFS; it keeps several images and only copies what changed),
   *A network folder* (`\\nas\backups`, with an account if the folder asks; Windows keeps the newest image there), or
   *An FBRX Server* (paste the **connection code** from the server's *FBRX Time → Computers*).
2. **When:** every day or every week at a time, or only when you ask. A computer that was off at that time makes the
   image when it is next on.
3. **Set up image backups.** Windows asks for administrator permission once. That makes a scheduled task
   (`\FBRX\Image backup`) that runs as the system: it makes the image Windows itself makes (every volume Windows needs
   to start, as virtual disks), even when nobody is signed in. The network folder's password is kept in a file only the
   system and administrators can read.

After that, *Back up now* (and FBRX Command's request) just starts the task: no more prompts. The card shows the last
image, when the next one is due and how many images the target holds. *Stop image backups* removes the task; the
images already made stay where they are.

The computer's other backup, the encrypted **snapshot**, is a different thing: it keeps FBRX itself (settings,
credentials, conversations, agent memory) and moves it to another computer ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

Good to know:

* **Images are not encrypted** the way BitLocker protects the computer's own drive. Keep the drive somewhere safe, or
  use the server's backup folder (only its own account can reach it).
* If a computer's edition of Windows will not save an image to a network folder (some Home editions), it can save to a
  drive instead.
* Images of the whole computer are made on Windows in this version; macOS comes later. The snapshot works
  everywhere.

### On the server: the backup folder

The `time` role shares one folder for computers: `\\<server>\fbrx-time`, with an account of its own (`fbrx-time`, no
sign-in to the server itself) and a long random password made at install. *FBRX Time → Computers* shows the folder, the
account and the password to administrators, and all three in one **connection code** for FBRX Endpoint. A computer
without FBRX Endpoint can use Windows' own system image to the same folder.

A network folder only ever holds a computer's latest image (Windows replaces it each time), so FBRX Time **keeps a copy
of each one that finishes** in its own store (`/var/lib/fbrx-time/images`), keeps as many of each computer as
*Settings* says, and boot-checks each new one when *Check computers' images when they arrive* is on. An image counts as
finished when nothing in it has changed for ten minutes; *Look now* checks straight away.

On a server that is also the gate (FBRX Gate), let your network reach the folder: a firewall rule allowing TCP 445
to the gate from the computers' network.

### Putting a computer back

* **From a drive or network folder:** start the computer from a Windows installer or recovery drive and choose
  *Repair your computer → Troubleshoot → System Image Recovery*, then pick the image.
* **From FBRX Server:** on *Images*, *Restore* a computer's image. FBRX Time copies it back into the backup folder
  under `Restore\<computer>-<date>`; in *System Image Recovery* choose *Select a system image → Advanced → Search for a
  system image on the network* and enter `\\<server>\fbrx-time\Restore\<computer>-<date>`, signing in with the folder's
  account.

## FBRX Command

* A device's **Overview** shows *Whole-computer image*: not set up, set up with no image yet, the last image and
  whether it worked, or *Making an image*.
* **Image backup now** (on the device page, for devices with image backups set up) and the **`backup.image`** command
  (*Send command*, for one device, a set, a group or the tenant) start an image on the computer, the same as its
  *Back up now*. They need a role that may send privileged commands. A computer without image backups set up answers
  that it is not set up; FBRX Command does not set them up for the person (that needs administrator permission on
  the computer).

## Setting up the role

```bash
sudo fbrx-server roles add time        # or, in the console: Roles → FBRX Time → Change the roles
```

The `time` role needs `virtual` (boot checks and restores run on FBRX Virtual). It installs Samba (for the backup
folder) and `qemu-utils`, makes `/var/lib/fbrx-time`, the `fbrx-time` account and its password
(`/etc/fbrx-time/share.env`, root only), and shares the folder. `fbrx-server status` and `fbrx-server doctor` cover it.
Turning the role off stops the sharing; the images stay in `/var/lib/fbrx-time`.

| Path | |
| --- | --- |
| `/var/lib/fbrx-time/images` | The images, one folder each (the disks, the machine's definition, the boot check's screen) |
| `/var/lib/fbrx-time/incoming` | The backup folder computers write to (`\\<server>\fbrx-time`) |
| `/var/lib/fbrx-time/lab` | Boot checks' throwaway layers while a check runs (emptied after) |
| `/etc/fbrx-time/share.env` | The backup folder's account and password |

## API

All under the console's API (`https://<server>:9443`, a session or API token). Running backups and checks needs an
operator; jobs, restores, deleting images and settings need an administrator.

| | |
| --- | --- |
| `GET /v1/time` | Status: space, the backup folder (password for administrators), computers, what is running |
| `GET/POST /v1/time/jobs`, `PUT/DELETE /v1/time/jobs/:id`, `POST /v1/time/jobs/:id/run` | Backup jobs |
| `POST /v1/time/backup` `{ vmId }` | One image now |
| `GET /v1/time/images[?subject=]` | Images, newest first |
| `POST /v1/time/images/:id/check` | Boot-check again |
| `GET /v1/time/images/:id/screenshot` | The boot check's screen (PNG) |
| `POST /v1/time/images/:id/restore` `{ name }` | A new virtual machine (or, for a computer, a copy in the backup folder) |
| `DELETE /v1/time/images/:id` | Delete an image |
| `POST /v1/time/computers/scan` | Look for finished computer backups now |
| `PUT /v1/time/settings` | Boot-check computers, how long a check runs, images kept per computer |
