<?php

declare(strict_types=1);

namespace OCA\RegiBase\BackgroundJob;

use OCA\RegiBase\Db\ShareEntity;
use OCA\RegiBase\Db\ShareMapper;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

/**
 * Once an hour: a share past its last day has its wrapped copy of the collection
 * key erased (owner, 2026-09-24: 「期限切れで鍵は抹消する」). It is also erased the
 * moment anybody touches the share; this is for the shares nobody opens.
 */
class ShareExpiry extends TimedJob {
	public function __construct(ITimeFactory $time, private ShareMapper $shares) {
		parent::__construct($time);
		$this->setInterval(3600);
	}

	protected function run($argument): void {
		foreach ($this->shares->findWithKeyAndEnd() as $s) {
			if (ShareEntity::isPast($s->getExpiresAt(), ShareEntity::ownerZone((string)$s->getOwnerUid()))) {
				$s->setEncKey(null);
				$s->setEncSalt(null);
				$this->shares->update($s);
			}
		}
	}
}
