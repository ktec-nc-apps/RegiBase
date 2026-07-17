<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use Symfony\Component\Console\Helper\Table;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class Records extends Base {
	protected function configure(): void {
		$this->setName('regibase:records')
			->setDescription('List the records of a collection')
			->addArgument('collection', InputArgument::REQUIRED, 'Collection id or name')
			->addUserOption()
			->addRevealOptions();
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$c = $this->resolveCollection($input);
		$key = $this->secretKey($c->getUserId(), $input, $output);

		$fieldsByKey = [];
		foreach ($this->fields->findForCollection((int)$c->getId()) as $f) {
			$fieldsByKey[$f->getFieldKey()] = $f;
		}

		$recs = $this->records->findForCollection((int)$c->getId());
		$output->writeln(sprintf('<info>%s %s</info> (#%d, %s) — %d record(s)',
			$c->getIcon(), $c->getName(), $c->getId(), $c->getUserId(), count($recs)));

		if (count($recs) === 0) {
			return 0;
		}

		$table = new Table($output);
		$table->setHeaders(['ID', 'Title', 'Updated']);
		foreach ($recs as $r) {
			$data = json_decode($r->getData() ?: '{}', true) ?: [];
			$table->addRow([
				$r->getId(),
				$this->titleOf($fieldsByKey, $data, $key),
				$r->getUpdatedAt(),
			]);
		}
		$table->render();
		return 0;
	}
}
