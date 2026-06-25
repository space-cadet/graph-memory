#!/bin/bash
# worker-ctl.sh — Graph Memory Queue Worker control script
# Usage: ./worker-ctl.sh {start|stop|status|restart|logs|enable|disable}

SERVICE="graph-memory-worker"

 case "$1" in
  start)
    systemctl --user start "$SERVICE"
    echo "Graph memory worker started."
    ;;
  stop)
    systemctl --user stop "$SERVICE"
    echo "Graph memory worker stopped."
    ;;
  status)
    systemctl --user status "$SERVICE"
    ;;
  restart)
    systemctl --user restart "$SERVICE"
    echo "Graph memory worker restarted."
    ;;
  logs)
    journalctl --user -u "$SERVICE" -f
    ;;
  enable)
    systemctl --user enable "$SERVICE"
    echo "Graph memory worker enabled (starts on login)."
    ;;
  disable)
    systemctl --user disable "$SERVICE"
    echo "Graph memory worker disabled."
    ;;
  *)
    echo "Usage: $0 {start|stop|status|restart|logs|enable|disable}"
    exit 1
    ;;
esac
