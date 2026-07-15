<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * Thrown when a share is protected by a share password and the current session
 * has not unlocked it yet. Mapped to HTTP 403 with code 'locked'.
 */
class LockedException extends \RuntimeException {
}
