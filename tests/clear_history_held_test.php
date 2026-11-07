<?php
/**
 * Regression test: clearing one's history of a collection lets that collection's held
 * attachments go only when it is one's own collection (review).
 *
 *   - bob names alice's collection: none of alice's held files go to the trash;
 *   - bob, given the collection, clears his history of it: none go either;
 *   - alice clears her own: the held file nothing names goes, as before.
 *
 * Run: php tests/clear_history_held_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('held attachments and other people clearing history', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Photos', [['key' => 'name', 'is_title' => true], ['key' => 'pic', 'type' => 'image']]);
	$w->record($a, ['name' => 'kept', 'pic' => '501']);
	$w->files->held['alice|RegiBase/Photos'] = ['777'];   // a deleted record's photo, kept for alice's undo

	$w->svc->clearHistory('bob', $a);
	check('a stranger naming the collection trashes nothing', $w->files->trashed === [], implode(',', $w->files->trashed));

	$w->share($a, 'alice', 'carol', 'edit');
	$w->svc->clearHistory('carol', $a);
	check('a recipient clearing their own history trashes nothing of the owner', $w->files->trashed === [], implode(',', $w->files->trashed));

	$w->svc->clearHistory('alice', $a);
	check('the owner clearing her history lets the unused held file go', $w->files->trashed === ['alice|777'], implode(',', $w->files->trashed));
});

finish();
