# esp32/cube/scripts/

Legacy device-side scripts retired in feature/esp32-devtool-foundation.
Use `esp32-devtool` for everything:

| Old                                   | New                                            |
|---------------------------------------|------------------------------------------------|
| `bash cube-cmd.sh state`              | `esp32-devtool cmd state`                      |
| `bash cube-snapshot.sh /tmp/x.png`    | `esp32-devtool screenshot --out /tmp/x.png`    |
| `bash flash.sh`                       | `esp32-devtool flash --profile debug`          |
| `bash find-port.sh`                   | `esp32-devtool --json info | jq -r .ip`        |
| `bash gdb-batch.sh`                   | `esp32-devtool gdb --batch ...`                |
| `bash setup-hil.sh`                   | `esp32-devtool setup --hil`                    |
| `bash monitor.sh`                     | `esp32-devtool logs --follow`                  |

The only script still in this directory is `bake-creds.sh`, kept as a transient
manifest extension. It retires when proper device pairing lands.
