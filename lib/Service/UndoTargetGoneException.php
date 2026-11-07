<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * An undo refused because the collection it would put records back into no longer
 * exists. Nothing was changed. A ForbiddenException, so every caller that counts
 * refused undo steps counts this one too.
 */
class UndoTargetGoneException extends ForbiddenException {
	/** The collection that is gone. */
	public int $collectionId = 0;

	public static function for(int $collectionId): self {
		$e = new self('The collection to put the records back into no longer exists.');
		$e->collectionId = $collectionId;
		return $e;
	}
}
