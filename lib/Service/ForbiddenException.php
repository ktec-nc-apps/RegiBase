<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * Thrown when a user can see a collection (it is shared to them) but lacks the
 * permission level required for the attempted action. Mapped to HTTP 403.
 */
class ForbiddenException extends \RuntimeException {
}
