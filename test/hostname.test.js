import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostsPath, addHostsEntry, removeHostsEntry, hasHostsEntry, nameIsSetUp } from '../hostname.js';

const WINDOWS_HOSTS = '# Copyright (c) 1993-2009 Microsoft Corp.\r\n#\r\n#      127.0.0.1       localhost\r\n';

test('finds the hosts file on Windows and elsewhere', () => {
  assert.equal(hostsPath('win32', { SystemRoot: 'D:\\WINDOWS' }), 'D:\\WINDOWS\\System32\\drivers\\etc\\hosts');
  assert.equal(hostsPath('win32', {}), 'C:\\Windows\\System32\\drivers\\etc\\hosts');
  assert.equal(hostsPath('linux', {}), '/etc/hosts');
  assert.equal(hostsPath('darwin', {}), '/etc/hosts');
});

test('adds the name once, keeping Windows line endings', () => {
  const added = addHostsEntry(WINDOWS_HOSTS);
  assert.equal(added, `${WINDOWS_HOSTS}127.0.0.1 manabuilder # added by mtg-manabase-builder\r\n`);
  assert.equal(addHostsEntry(added), null);
  assert.equal(addHostsEntry(''), '127.0.0.1 manabuilder # added by mtg-manabase-builder\n');
  // A last line with no line break gets one before the new line.
  assert.equal(addHostsEntry('127.0.0.1 localhost'), '127.0.0.1 localhost\n127.0.0.1 manabuilder # added by mtg-manabase-builder\n');
});

test('a line of your own counts; a commented-out one or a longer name does not', () => {
  assert.equal(hasHostsEntry('192.168.1.20\tlocalhost  ManaBuilder\n'), true);
  assert.equal(addHostsEntry('192.168.1.20 manabuilder\n'), null);
  assert.equal(hasHostsEntry('# 127.0.0.1 manabuilder\n'), false);
  assert.equal(hasHostsEntry('127.0.0.1 manabuilder.lan\n'), false);
  assert.equal(hasHostsEntry('127.0.0.1 localhost # manabuilder\n'), false);
});

test('removes only the line it added', () => {
  const added = addHostsEntry(WINDOWS_HOSTS);
  assert.equal(removeHostsEntry(added), WINDOWS_HOSTS);
  assert.equal(removeHostsEntry(WINDOWS_HOSTS), null);
  assert.equal(removeHostsEntry('127.0.0.1 manabuilder\n'), null);
});

test('reads whether this computer has the name set up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hosts-'));
  const file = join(dir, 'hosts');
  await writeFile(file, addHostsEntry(WINDOWS_HOSTS));
  assert.equal(await nameIsSetUp(file), true);
  await writeFile(file, WINDOWS_HOSTS);
  assert.equal(await nameIsSetUp(file), false);
  assert.equal(await nameIsSetUp(join(dir, 'missing')), false);
});
