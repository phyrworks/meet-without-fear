#!/usr/bin/env python3
"""Run a production SELECT through a verified SSH tunnel using a readonly role."""
import json, os, pathlib, shutil, socket, subprocess, sys
config = json.loads((pathlib.Path.home()/'.config/mwf/production.json').read_text())
port = config.get('local_port', 15432)
try:
    with socket.create_connection(('127.0.0.1', port), timeout=2): pass
except OSError:
    subprocess.run(['ssh', '-f', '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
                    '-L', f'127.0.0.1:{port}:127.0.0.1:5432', config['ssh_host']], check=True)
psql = shutil.which('psql') or '/opt/homebrew/opt/postgresql@18/bin/psql'
env = os.environ.copy()
env.update(PGHOST='127.0.0.1', PGPORT=str(port), PGDATABASE='mwf', PGUSER='slam_bot_readonly',
           PGPASSWORD=config['readonly_password'], PGSSLMODE='disable', PGCONNECT_TIMEOUT='10',
           PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000')
probe = subprocess.run([psql, '-X', '-Atc', "SELECT current_database() || '|' || current_user;"],
                       env=env, capture_output=True, text=True)
if probe.returncode:
    sys.exit("Production tunnel check failed: " + probe.stderr.strip())
if probe.stdout.strip() != 'mwf|slam_bot_readonly':
    sys.exit('Wrong database or role on the forwarded port; refusing query.')
print('Target: AWS mwf via verified SSH forwarding (readonly)', file=sys.stderr)
args = [psql, '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off']
if len(sys.argv) > 1: args += ['-c', sys.argv[1]]
sys.exit(subprocess.run(args, env=env).returncode)
